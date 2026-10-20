/**
 * Tests for POST /api/decks/sync-moxfield — the on-demand "sync my public
 * Moxfield decks now" endpoint.
 */

const mockUserFindUnique = jest.fn();

jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
    },
  },
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}));

const mockGetSession = jest.fn();
jest.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));

const mockSyncUserDecks = jest.fn();
jest.mock('@/lib/moxfieldDeckSync', () => ({
  syncUserMoxfieldDecks: (...a: unknown[]) => mockSyncUserDecks(...a),
}));

let ipCounter = 0;
function makeRequest(): Request {
  ipCounter += 1;
  return {
    headers: { get: (n: string) => (n === 'x-forwarded-for' ? `10.3.0.${ipCounter}` : null) },
  } as unknown as Request;
}

const MEMBER = { userId: 'u1', role: 'MEMBER', isLegacyAdmin: false };
const LEGACY = { userId: '__legacy_admin__', role: 'ADMIN', isLegacyAdmin: true };

import { POST } from '../src/app/api/decks/sync-moxfield/route';

const SYNC_RESULT = {
  userName: 'Amirali',
  discovered: 2,
  imported: [{ id: 'd1', name: 'Krenko', excludedCards: [] }],
  skippedLinked: ['Old'],
  skippedNameCollision: [],
  failed: [],
};

describe('POST /api/decks/sync-moxfield', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockUserFindUnique.mockReset();
    mockSyncUserDecks.mockReset();
    mockGetSession.mockResolvedValue(MEMBER);
    mockUserFindUnique.mockResolvedValue({ moxfieldUsername: 'AVLTG' });
    mockSyncUserDecks.mockResolvedValue(SYNC_RESULT);
  });

  it('runs the sync for the session user and returns the summary', async () => {
    const res: any = await POST(makeRequest());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SYNC_RESULT);
    expect(mockSyncUserDecks).toHaveBeenCalledWith('u1');
  });

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const res: any = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it('blocks the legacy bootstrap admin', async () => {
    mockGetSession.mockResolvedValue(LEGACY);
    const res: any = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('400s when no Moxfield account is connected', async () => {
    mockUserFindUnique.mockResolvedValue({ moxfieldUsername: null });
    const res: any = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Connect your Moxfield account first');
    expect(mockSyncUserDecks).not.toHaveBeenCalled();
  });

  it('maps a sync failure to 502 without leaking a stack', async () => {
    mockSyncUserDecks.mockRejectedValue(new Error('Moxfield took too long'));
    const res: any = await POST(makeRequest());
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Moxfield took too long');
  });
});
