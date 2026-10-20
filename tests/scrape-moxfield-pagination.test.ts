/**
 * Tests for scrapeMoxfield pagination. The loop must decide "was this a full
 * page" from the RAW key count, not the post-filter count: basics/tokens are
 * filtered out before the check, so a filtered count can look like a short
 * page even when Moxfield returned a full one — silently truncating large
 * collections to page 1.
 */

jest.mock('server-only', () => ({}), { virtual: true });

const mockFetchMoxfieldApi = jest.fn();
jest.mock('@/lib/moxfieldApi', () => ({
  fetchMoxfieldApi: (...args: any[]) => mockFetchMoxfieldApi(...args),
}));

import { scrapeMoxfield } from '../src/lib/scrapeMoxfield/scrapeMoxfield';

function page(entries: Record<string, unknown>) {
  return { data: entries };
}

function card(name: string, typeLine = 'Creature — Goblin') {
  return {
    card: {
      name,
      scryfall_id: `id-${name}`,
      set: 'x',
      set_name: 'Set',
      type_line: typeLine,
    },
    quantity: 1,
    condition: 'NM',
    isFoil: false,
  };
}

// The scraper always requests pageSize=5000; a "full page" means 5000 raw keys.
function fullPageWithBasics(): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 4995; i++) entries[`k${i}`] = card(`Card ${i}`);
  // 5 basic lands — filtered out of pageCards, but they DO count toward the
  // raw page size Moxfield returned.
  for (let i = 0; i < 5; i++) entries[`b${i}`] = card(`Plains ${i}`, 'Basic Land — Plains');
  return entries;
}

describe('scrapeMoxfield pagination', () => {
  beforeEach(() => {
    mockFetchMoxfieldApi.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore();
  });

  it('keeps paginating when a full page contains filtered basics (no silent truncation)', async () => {
    const pageTwo: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) pageTwo[`k${i}`] = card(`Tail ${i}`);
    mockFetchMoxfieldApi
      .mockResolvedValueOnce(page(fullPageWithBasics()))
      .mockResolvedValueOnce(page(pageTwo));

    const cards = await scrapeMoxfield({ collectionId: 'c1' });

    expect(mockFetchMoxfieldApi).toHaveBeenCalledTimes(2);
    // 4995 real cards from page 1 + 10 from page 2 — not a page-1 truncation.
    expect(cards).toHaveLength(5005);
    expect(cards.some((c) => c.name === 'Tail 9')).toBe(true);
    expect(cards.some((c) => c.name.startsWith('Plains'))).toBe(false);
  });

  it('stops after a short page', async () => {
    const shortPage: Record<string, unknown> = {};
    for (let i = 0; i < 42; i++) shortPage[`k${i}`] = card(`Card ${i}`);
    mockFetchMoxfieldApi.mockResolvedValueOnce(page(shortPage));

    const cards = await scrapeMoxfield({ collectionId: 'c2' });

    expect(mockFetchMoxfieldApi).toHaveBeenCalledTimes(1);
    expect(cards).toHaveLength(42);
  });

  it('filters tokens out of the result', async () => {
    mockFetchMoxfieldApi.mockResolvedValueOnce(page({
      a: card('Goblin Token', 'Token Creature — Goblin'),
      b: card('Real Card'),
    }));
    const cards = await scrapeMoxfield({ collectionId: 'c3' });
    expect(cards.map((c) => c.name)).toEqual(['Real Card']);
  });
});
