/**
 * Tests for src/lib/moxfieldApi.ts — URL construction, response mapping and
 * pagination for the public Moxfield endpoints (user search + deck listing).
 * Runs the ScraperAPI branch (SCRAPER_API_KEY set) so global fetch can be
 * mocked — the same trick scrape-moxfield-pagination.test.ts uses.
 */

process.env.SCRAPER_API_KEY = 'test-key';

const mockFetch = jest.fn();
jest.spyOn(global, 'fetch').mockImplementation((...args: any[]) => mockFetch(...args));

import { searchMoxfieldUsers, listMoxfieldDecksByUsername } from '../src/lib/moxfieldApi';

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/** Extracts the proxied target URL from the ScraperAPI wrapper URL. */
function proxiedUrl(call: any[]): string {
  const wrapper = String(call[0]);
  const encoded = wrapper.split('url=')[1];
  return decodeURIComponent(encoded);
}

describe('searchMoxfieldUsers', () => {
  beforeEach(() => mockFetch.mockReset());

  it('queries /v2/users/search with the encoded filter and maps results', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [
        { userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: 'https://img/x.png' },
        { userName: 'avltg2' },
        { displayName: 'no-username-should-be-dropped' },
      ],
    }));

    const users = await searchMoxfieldUsers('AV LT');

    expect(proxiedUrl(mockFetch.mock.calls[0])).toBe(
      'https://api2.moxfield.com/v2/users/search?filter=AV%20LT&pageSize=8'
    );
    expect(users).toEqual([
      { userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: 'https://img/x.png' },
      { userName: 'avltg2', displayName: 'avltg2', profileImageUrl: null },
    ]);
  });

  it('returns [] when Moxfield reports an empty data array', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await expect(searchMoxfieldUsers('zzz')).resolves.toEqual([]);
  });
});

describe('listMoxfieldDecksByUsername', () => {
  beforeEach(() => mockFetch.mockReset());

  it('queries /v2/decks/search by author and maps publicId/name', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      totalPages: 1,
      data: [
        { publicId: 'abc_123', name: 'Krenko' },
        { name: 'missing publicId is dropped' },
      ],
    }));

    const decks = await listMoxfieldDecksByUsername('AVLTG');

    expect(proxiedUrl(mockFetch.mock.calls[0])).toBe(
      'https://api2.moxfield.com/v2/decks/search?authorUserNames=AVLTG&pageNumber=1&pageSize=100&sortType=updated&sortDirection=descending'
    );
    expect(decks).toEqual([{ publicId: 'abc_123', name: 'Krenko' }]);
  });

  it('paginates through totalPages', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        totalPages: 2,
        data: [{ publicId: 'p1', name: 'Deck One' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        totalPages: 2,
        data: [{ publicId: 'p2', name: 'Deck Two' }],
      }));

    const decks = await listMoxfieldDecksByUsername('someone');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(proxiedUrl(mockFetch.mock.calls[1])).toContain('pageNumber=2');
    expect(decks.map((d) => d.publicId)).toEqual(['p1', 'p2']);
  });

  it('stops at maxPages even if Moxfield reports more', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      totalPages: 50,
      data: [{ publicId: `p`, name: 'D' }],
    }));

    await listMoxfieldDecksByUsername('someone', 2);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
