const mockGetSession = jest.fn()
jest.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }))

const mockFetchMoxfieldApi = jest.fn()
jest.mock('@/lib/moxfieldApi', () => ({
  fetchMoxfieldApi: (...a: unknown[]) => mockFetchMoxfieldApi(...a),
}))

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    })),
  },
}))

let ipCounter = 100
function makeRequest(body?: Record<string, unknown>): Request {
  ipCounter += 1
  return {
    json: async () => body ?? {},
    headers: { get: (n: string) => (n === 'x-forwarded-for' ? `10.9.9.${ipCounter}` : null) },
  } as unknown as Request
}

import { POST } from '../src/app/api/decks/fetch-url/route'

const MEMBER = { userId: 'u1', role: 'MEMBER', isLegacyAdmin: false }

const VIEW_FIXTURE = {
  name: 'Dragons',
  format: 'commander',
  commanders: { k: { quantity: 1, card: { name: 'Ur-Dragon', set: 'cmm', cn: '1' } } },
  mainboard: { a: { quantity: 1, card: { name: 'Sol Ring', set: 'c21', cn: '263' } } },
  sideboard: {},
  maybeboard: {},
}

describe('POST /api/decks/fetch-url', () => {
  beforeEach(() => {
    mockGetSession.mockReset()
    mockGetSession.mockResolvedValue(MEMBER)
    mockFetchMoxfieldApi.mockReset()
  })

  it('401s unauthenticated callers', async () => {
    mockGetSession.mockResolvedValue(null)
    const res: any = await POST(makeRequest({ url: 'https://moxfield.com/decks/abc123' }))
    expect(res.status).toBe(401)
  })

  it('400s non-Moxfield URLs without fetching', async () => {
    const res: any = await POST(makeRequest({ url: 'https://example.com/decks/abc' }))
    expect(res.status).toBe(400)
    expect(mockFetchMoxfieldApi).not.toHaveBeenCalled()
  })

  it('maps upstream 404 to 404 and other failures to 502', async () => {
    mockFetchMoxfieldApi.mockRejectedValueOnce(new Error('curl: (22) The requested URL returned error: 404'))
    expect(((await POST(makeRequest({ url: 'https://moxfield.com/decks/abc123' }))) as any).status).toBe(404)
    mockFetchMoxfieldApi.mockRejectedValueOnce(new Error('ScraperAPI returned 503 for ...'))
    const res: any = await POST(makeRequest({ url: 'abc123' }))
    expect(res.status).toBe(502)
  })

  it('returns converted boards on success', async () => {
    mockFetchMoxfieldApi.mockResolvedValueOnce(VIEW_FIXTURE)
    const res: any = await POST(makeRequest({ url: 'https://moxfield.com/decks/abc123' }))
    expect(res.status).toBe(200)
    expect(res.body.deck.name).toBe('Dragons')
    expect(res.body.deck.commander).toBe('Ur-Dragon')
    expect(res.body.deck.main).toContain('Sol Ring')
  })
})
