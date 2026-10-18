/**
 * Tests for /api/users/me/moxfield — the self-service "connect your Moxfield
 * account" endpoint (GET status, PUT connect, DELETE disconnect).
 */

const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();

jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
      update: (...a: unknown[]) => mockUserUpdate(...a),
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

const mockSearchUsers = jest.fn();
jest.mock('@/lib/moxfieldApi', () => ({
  searchMoxfieldUsers: (...a: unknown[]) => mockSearchUsers(...a),
}));

let ipCounter = 0;
function makeRequest(method: string, body?: Record<string, unknown>): Request {
  ipCounter += 1;
  return {
    method,
    json: async () => body,
    headers: { get: (n: string) => (n === 'x-forwarded-for' ? `10.1.0.${ipCounter}` : null) },
  } as unknown as Request;
}

const MEMBER = { userId: 'u1', role: 'MEMBER', isLegacyAdmin: false };
const LEGACY = { userId: '__legacy_admin__', role: 'ADMIN', isLegacyAdmin: true };

import { GET, PUT, DELETE } from '../src/app/api/users/me/moxfield/route';

describe('GET /api/users/me/moxfield', () => {
  beforeEach(() => { mockUserFindUnique.mockReset(); mockGetSession.mockReset(); });

  it('returns the connected username', async () => {
    mockGetSession.mockResolvedValue(MEMBER);
    mockUserFindUnique.mockResolvedValue({ moxfieldUsername: 'AVLTG' });
    const res: any = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moxfieldUsername: 'AVLTG' });
  });

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const res: any = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/users/me/moxfield', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSearchUsers.mockReset();
    mockUserUpdate.mockReset();
    mockGetSession.mockResolvedValue(MEMBER);
    mockSearchUsers.mockResolvedValue([{ userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: null }]);
    mockUserUpdate.mockResolvedValue({ moxfieldUsername: 'AVLTG' });
  });

  it('connects using Moxfield canonical casing after verifying the account exists', async () => {
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'avltg' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moxfieldUsername: 'AVLTG' });
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { moxfieldUsername: 'AVLTG' },
      select: { moxfieldUsername: true },
    });
  });

  it('rejects usernames that do not exist on Moxfield', async () => {
    mockSearchUsers.mockResolvedValue([{ userName: 'someone-else' }]);
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'ghost' }));
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No Moxfield user');
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('maps a Moxfield lookup failure to 502', async () => {
    mockSearchUsers.mockRejectedValue(new Error('cloudflare'));
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'avltg' }));
    expect(res.status).toBe(502);
  });

  it('rejects malformed usernames (400) without hitting Moxfield', async () => {
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'a' }));
    expect(res.status).toBe(400);
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('blocks the legacy bootstrap admin', async () => {
    mockGetSession.mockResolvedValue(LEGACY);
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'avltg' }));
    expect(res.status).toBe(403);
  });

  it('409s when another user already connected that Moxfield username', async () => {
    mockUserUpdate.mockRejectedValue({ code: 'P2002' });
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'avltg' }));
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already connected');
  });

  it('404s when the session user has no account row', async () => {
    mockUserUpdate.mockRejectedValue({ code: 'P2025' });
    const res: any = await PUT(makeRequest('PUT', { moxfieldUsername: 'avltg' }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/users/me/moxfield', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockUserUpdate.mockReset();
    mockGetSession.mockResolvedValue(MEMBER);
    mockUserUpdate.mockResolvedValue({ moxfieldUsername: null });
  });

  it('clears the connection', async () => {
    const res: any = await DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { moxfieldUsername: null },
    });
    expect(res.body).toEqual({ moxfieldUsername: null });
  });

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const res: any = await DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(401);
  });
});
