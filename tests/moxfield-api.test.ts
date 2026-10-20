/**
 * Tests for src/lib/moxfieldApi.ts — the fetch strategy chain (curl →
 * Chromium → optional ScraperAPI) plus URL construction, response mapping
 * and pagination for the public Moxfield endpoints. All network strategies
 * are injected fakes; nothing here touches the real internet.
 */

jest.mock('server-only', () => ({}), { virtual: true });

import {
  fetchMoxfieldApi,
  searchMoxfieldUsers,
  listMoxfieldDecksByUsername,
} from '../src/lib/moxfieldApi';

function jsonResponse(body: unknown) {
  return async () => body;
}

describe('fetchMoxfieldApi strategy chain', () => {
  const strategies = () => ({
    curl: jest.fn(),
    browser: jest.fn(),
    scraper: jest.fn(),
  });

  afterEach(() => {
    delete process.env.SCRAPER_API_KEY;
  });

  it('uses curl when it works and never touches the browser', async () => {
    const s = strategies();
    s.curl.mockResolvedValue({ ok: true });
    await fetchMoxfieldApi('/v2/x', s);
    expect(s.curl).toHaveBeenCalledWith('https://api2.moxfield.com/v2/x');
    expect(s.browser).not.toHaveBeenCalled();
    expect(s.scraper).not.toHaveBeenCalled();
  });

  it('falls back to the browser when curl is unavailable (Vercel: no curl binary)', async () => {
    const s = strategies();
    s.curl.mockRejectedValue(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }));
    s.browser.mockResolvedValue({ via: 'browser' });
    await expect(fetchMoxfieldApi('/v2/x', s)).resolves.toEqual({ via: 'browser' });
    expect(s.scraper).not.toHaveBeenCalled();
  });

  it('propagates real curl HTTP errors instead of retrying (Moxfield answered)', async () => {
    const s = strategies();
    s.curl.mockRejectedValue(new Error('curl: (22) The requested URL returned error: 404'));
    await expect(fetchMoxfieldApi('/v2/x', s)).rejects.toThrow(/404/);
    expect(s.browser).not.toHaveBeenCalled();
    expect(s.scraper).not.toHaveBeenCalled();
  });

  it('uses ScraperAPI as the last resort only when the key is set', async () => {
    const s = strategies();
    s.curl.mockRejectedValue(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }));
    s.browser.mockRejectedValue(new Error('navigation timeout'));
    s.scraper.mockResolvedValue({ via: 'scraper' });
    process.env.SCRAPER_API_KEY = 'key-1';
    await expect(fetchMoxfieldApi('/v2/x', s)).resolves.toEqual({ via: 'scraper' });
    expect(s.scraper).toHaveBeenCalledWith('https://api2.moxfield.com/v2/x', 'key-1');
  });

  it('throws the browser error when every strategy fails and no key is set', async () => {
    const s = strategies();
    s.curl.mockRejectedValue(Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' }));
    s.browser.mockRejectedValue(new Error('Chromium crashed'));
    await expect(fetchMoxfieldApi('/v2/x', s)).rejects.toThrow(/Chromium crashed/);
    expect(s.scraper).not.toHaveBeenCalled();
  });
});

describe('searchMoxfieldUsers', () => {
  it('queries /v2/users/search with the encoded filter and maps results', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      data: [
        { userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: 'https://img/x.png' },
        { userName: 'avltg2' },
        { displayName: 'no-username-should-be-dropped' },
      ],
    });

    const users = await searchMoxfieldUsers('AV LT', fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      '/v2/users/search?filter=AV%20LT&pageSize=8'
    );
    expect(users).toEqual([
      { userName: 'AVLTG', displayName: 'AVLTG', profileImageUrl: 'https://img/x.png' },
      { userName: 'avltg2', displayName: 'avltg2', profileImageUrl: null },
    ]);
  });

  it('returns [] when Moxfield reports an empty data array', async () => {
    const fetcher = jest.fn().mockResolvedValue({ data: [] });
    await expect(searchMoxfieldUsers('zzz', fetcher)).resolves.toEqual([]);
  });
});

describe('listMoxfieldDecksByUsername', () => {
  it('queries /v2/decks/search by author and maps publicId/name', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      totalPages: 1,
      data: [
        { publicId: 'abc_123', name: 'Krenko' },
        { name: 'missing publicId is dropped' },
      ],
    });

    const decks = await listMoxfieldDecksByUsername('AVLTG', fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      '/v2/decks/search?authorUserNames=AVLTG&pageNumber=1&pageSize=100&sortType=updated&sortDirection=descending'
    );
    expect(decks).toEqual([{ publicId: 'abc_123', name: 'Krenko' }]);
  });

  it('paginates through totalPages', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce({ totalPages: 2, data: [{ publicId: 'p1', name: 'Deck One' }] })
      .mockResolvedValueOnce({ totalPages: 2, data: [{ publicId: 'p2', name: 'Deck Two' }] });

    const decks = await listMoxfieldDecksByUsername('someone', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toContain('pageNumber=2');
    expect(decks.map((d) => d.publicId)).toEqual(['p1', 'p2']);
  });

  it('stops at maxPages even if Moxfield reports more', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      totalPages: 50,
      data: [{ publicId: 'p', name: 'D' }],
    });

    await listMoxfieldDecksByUsername('someone', fetcher, 2);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
