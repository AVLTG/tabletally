import { parseMoxfieldDeckId, fetchMoxfieldDeck } from '@/lib/moxfieldDeckFetch';

describe('parseMoxfieldDeckId', () => {
  it.each([
    ['https://moxfield.com/decks/abc123XYZ', 'abc123XYZ'],
    ['https://www.moxfield.com/decks/abc123XYZ-my-cool-deck', 'abc123XYZ-my-cool-deck'],
    ['http://moxfield.com/decks/abc123XYZ/', 'abc123XYZ'],
    ['moxfield.com/decks/abc123XYZ?foo=bar', 'abc123XYZ'],
    ['abc123XYZ', 'abc123XYZ'],
    ['  https://moxfield.com/decks/abc123XYZ  ', 'abc123XYZ'],
  ])('parses %s', (input, expected) => {
    expect(parseMoxfieldDeckId(input)).toBe(expected);
  });

  it.each([[''], ['not a url at all'], ['https://example.com/decks/abc'], ['https://moxfield.com/collection/abc']])(
    'rejects %s',
    (input) => {
      expect(parseMoxfieldDeckId(input)).toBeNull();
    }
  );
});

const viewFixture = {
  name: 'Dragonstorm',
  format: 'commander',
  commanders: {
    k1: { quantity: 1, card: { name: 'Ur-Dragon', set: 'cmm', cn: '1' } },
  },
  mainboard: {
    a: { quantity: 1, finish: 'nonFoil', card: { name: 'Sol Ring', set: 'c21', cn: '263' } },
    b: { quantity: 4, finish: 'foil', card: { name: 'Lightning Bolt', set: 'lea', cn: '100' } },
    c: { quantity: 10, card: { name: 'Forest' } },
  },
  sideboard: {
    s: { quantity: 2, card: { name: 'Side Card', set: 'm21', cn: '5' } },
  },
  maybeboard: {},
};

describe('fetchMoxfieldDeck', () => {
  const ok = (body: unknown) => async () => body;

  it('converts boards to plaintext and extracts format/commander', async () => {
    const deck = await fetchMoxfieldDeck('https://moxfield.com/decks/abc123', ok(viewFixture));
    expect(deck.name).toBe('Dragonstorm');
    expect(deck.format).toBe('commander');
    expect(deck.commander).toBe('Ur-Dragon');
    expect(deck.main).toBe('1 Sol Ring (C21) 263\n4 Lightning Bolt (LEA) 100 *F*\n10 Forest');
    expect(deck.side).toBe('2 Side Card (M21) 5');
    expect(deck.maybe).toBe('');
  });

  it('parses the v3 response shape (boards nested under "boards", cards under "cards")', async () => {
    const v3 = {
      name: 'MEAD',
      format: 'commander',
      boards: {
        // Real v3 shape: each board is { count, cards: { key: entry } }
        mainboard: { count: 3, cards: viewFixture.mainboard },
        commanders: { count: 1, cards: viewFixture.commanders },
        sideboard: { count: 1, cards: viewFixture.sideboard },
        maybeboard: { count: 0, cards: {} },
      },
    };
    const deck = await fetchMoxfieldDeck('abc123', ok(v3));
    expect(deck.name).toBe('MEAD');
    expect(deck.commander).toBe('Ur-Dragon');
    expect(deck.main).toContain('Sol Ring (C21) 263');
    expect(deck.main).toContain('10 Forest');
    expect(deck.side).toBe('2 Side Card (M21) 5');
    expect(deck.maybe).toBe('');
  });

  it('throws a friendly error for non-URLs', async () => {
    await expect(fetchMoxfieldDeck('garbage input here', ok({}))).rejects.toThrow(
      /does not look like a Moxfield/i
    );
  });

  it('throws a friendly error on 404', async () => {
    const notFound = async () => {
      throw new Error('curl: (22) The requested URL returned error: 404');
    };
    await expect(fetchMoxfieldDeck('abc123', notFound)).rejects.toThrow(/not found/i);
  });

  it('throws on server errors with a retry hint', async () => {
    const serverError = async () => {
      throw new Error('ScraperAPI returned 503 for https://api2.moxfield.com/...');
    };
    await expect(fetchMoxfieldDeck('abc123', serverError)).rejects.toThrow(/try again/i);
  });

  it('throws a generic blocking message when no HTTP status is identifiable', async () => {
    const blocked = async () => {
      throw new Error('Unexpected token < in JSON');
    };
    await expect(fetchMoxfieldDeck('abc123', blocked)).rejects.toThrow(/blocking the request/i);
  });
});
