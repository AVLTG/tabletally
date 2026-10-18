/**
 * Tests for /api/moxfield/user-search — the logged-in username lookup proxy
 * used by the connect flow.
 */

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
function makeRequest(url: string): Request {
  ipCounter += 1;
  return {
    url: `https://tabletally.local${url}`,
    headers: { get: (n: string) => (n === 'x-forwarded-for' ? `10.2.0.${ipCounter}` : null) },
  } as unknown as Request;
}

const MEMBER = { userId: 'u1', role: 'MEMBER', isLegacyAdmin: false };

import { GET } from '../src/app/api/moxfield/user-search/route';

describe('GET /api/moxfield/user-search', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockSearchUsers.mockReset();
    mockGetSession.mockResolvedValue(MEMBER);
    mockSearchUsers.mockResolvedValue([
      { userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: null },
    ]);
  });

  it('proxies the filter to Moxfield and returns the matches', async () => {
    const res: any = await GET(makeRequest('/api/moxfield/user-search?filter=AVLT'));
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([{ userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: null }]);
    expect(mockSearchUsers).toHaveBeenCalledWith('AVLT');
  });

  it('requires a session', async () => {
    mockGetSession.mockResolvedValue(null);
    const res: any = await GET(makeRequest('/api/moxfield/user-search?filter=AVLT'));
    expect(res.status).toBe(401);
  });

  it('rejects filters shorter than Moxfield requires (400)', async () => {
    const res: any = await GET(makeRequest('/api/moxfield/user-search?filter=av'));
    expect(res.status).toBe(400);
    expect(mockSearchUsers).not.toHaveBeenCalled();
  });

  it('maps a Moxfield failure to 502', async () => {
    mockSearchUsers.mockRejectedValue(new Error('upstream'));
    const res: any = await GET(makeRequest('/api/moxfield/user-search?filter=AVLT'));
    expect(res.status).toBe(502);
  });
});
