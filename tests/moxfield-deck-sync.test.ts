/**
 * Tests for src/lib/moxfieldDeckSync.ts — the nightly "auto-import a user's
 * public Moxfield decks" pipeline. Network calls (deck listing, deck fetch,
 * enrichment) and Prisma are mocked; the parse/classify path is real.
 */

const mockUserFindMany = jest.fn();
const mockUserFindUnique = jest.fn();
const mockDeckFindMany = jest.fn();
const mockDeckCreate = jest.fn();
const mockCollectionCardFindMany = jest.fn();

jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findMany: (...a: unknown[]) => mockUserFindMany(...a),
      findUnique: (...a: unknown[]) => mockUserFindUnique(...a),
    },
    deck: {
      findMany: (...a: unknown[]) => mockDeckFindMany(...a),
      create: (...a: unknown[]) => mockDeckCreate(...a),
    },
    collectionCard: {
      findMany: (...a: unknown[]) => mockCollectionCardFindMany(...a),
    },
  },
}));

const mockListDecks = jest.fn();
jest.mock('@/lib/moxfieldApi', () => ({
  listMoxfieldDecksByUsername: (...a: unknown[]) => mockListDecks(...a),
}));

const mockFetchDeck = jest.fn();
jest.mock('@/lib/moxfieldDeckFetch', () => ({
  fetchMoxfieldDeck: (...a: unknown[]) => mockFetchDeck(...a),
}));

const mockEnrich = jest.fn();
jest.mock('@/lib/deckEnrich', () => ({
  enrichDeckCards: (...a: unknown[]) => mockEnrich(...a),
}));

import { syncUserMoxfieldDecks, syncAllMoxfieldDecks } from '../src/lib/moxfieldDeckSync';

const USER = { id: 'u1', name: 'Amirali', moxfieldUsername: 'AVLTG' };

function fetchedDeck(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mx1',
    name: 'Krenko',
    format: 'commander',
    commander: 'Krenko, Mob Boss',
    // One card in the library, one basic (imports freely), one missing.
    main: '1 Krenko, Mob Boss\n4 Mountain\n1 Expensive Card',
    side: '',
    maybe: '',
    ...overrides,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockUserFindMany.mockClear();
  mockUserFindUnique.mockClear();
  mockDeckFindMany.mockClear();
  mockDeckCreate.mockClear();
  mockCollectionCardFindMany.mockClear();
  mockListDecks.mockClear();
  mockFetchDeck.mockClear();
  mockEnrich.mockClear();
  mockUserFindUnique.mockResolvedValue(USER);
  mockDeckFindMany.mockResolvedValue([]); // no linked decks, no owned decks
  mockCollectionCardFindMany.mockResolvedValue([{ cardName: 'Krenko, Mob Boss' }]);
  mockDeckCreate.mockImplementation(({ data }) =>
    Promise.resolve({ id: `new-${data.name}`, ...data })
  );
  mockFetchDeck.mockResolvedValue(fetchedDeck());
  mockEnrich.mockResolvedValue(undefined);
  mockListDecks.mockResolvedValue([{ publicId: 'pub1', name: 'Krenko' }]);
});

afterEach(() => {
  (console.log as jest.Mock).mockRestore();
  (console.error as jest.Mock).mockRestore();
});

describe('syncUserMoxfieldDecks', () => {
  it('imports a new public deck with owner, moxfieldPublicId and library-filtered cards', async () => {
    const result = await syncUserMoxfieldDecks('u1');

    expect(result.discovered).toBe(1);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ name: 'Krenko', excludedCards: ['Expensive Card'] });

    expect(mockDeckCreate).toHaveBeenCalledTimes(1);
    const arg = mockDeckCreate.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      name: 'Krenko',
      ownerUserId: 'u1',
      format: 'commander',
      commander: 'Krenko, Mob Boss',
      moxfieldPublicId: 'pub1',
    });
    // Library card + basic land make it in; the missing card does not.
    const cards = arg.data.cards.create as Array<{ cardName: string; quantity: number; board: string }>;
    expect(cards).toEqual([
      { cardName: 'Krenko, Mob Boss', quantity: 1, board: 'main', isFoil: false },
      { cardName: 'Mountain', quantity: 4, board: 'main', isFoil: false },
    ]);
    // Enrichment runs best-effort after creation.
    expect(mockEnrich).toHaveBeenCalledWith('new-Krenko');
  });

  it('skips decks already linked by moxfieldPublicId', async () => {
    mockDeckFindMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        where.moxfieldPublicId ? [{ moxfieldPublicId: 'pub1' }] : []
      )
    );

    const result = await syncUserMoxfieldDecks('u1');

    expect(result.skippedLinked).toEqual(['Krenko']);
    expect(result.imported).toHaveLength(0);
    expect(mockFetchDeck).not.toHaveBeenCalled();
    expect(mockDeckCreate).not.toHaveBeenCalled();
  });

  it('skips decks whose name collides with a deck the user already owns', async () => {
    mockDeckFindMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(where.moxfieldPublicId ? [] : [{ name: 'krenko ' }])
    );

    const result = await syncUserMoxfieldDecks('u1');

    expect(result.skippedNameCollision).toEqual(['Krenko']);
    expect(mockDeckCreate).not.toHaveBeenCalled();
  });

  it('records per-deck failures instead of throwing', async () => {
    mockListDecks.mockResolvedValue([
      { publicId: 'pub1', name: 'Good' },
      { publicId: 'pub2', name: 'Bad' },
    ]);
    mockFetchDeck.mockImplementation((id: string) =>
      id === 'pub1' ? Promise.resolve(fetchedDeck({ name: 'Good' })) : Promise.reject(new Error('Moxfield returned 503'))
    );

    const result = await syncUserMoxfieldDecks('u1');

    expect(result.imported.map((d) => d.name)).toEqual(['Good']);
    expect(result.failed).toEqual([{ name: 'Bad', error: 'Moxfield returned 503' }]);
  });

  it('imports side and maybe boards with their board tags', async () => {
    mockFetchDeck.mockResolvedValue(fetchedDeck({ side: '1 Krenko, Mob Boss', maybe: '4 Mountain' }));

    await syncUserMoxfieldDecks('u1');

    const cards = mockDeckCreate.mock.calls[0][0].data.cards.create as Array<{ cardName: string; board: string }>;
    expect(cards.map((c) => `${c.cardName}:${c.board}`)).toEqual([
      'Krenko, Mob Boss:main',
      'Mountain:main',
      'Krenko, Mob Boss:side',
      'Mountain:maybe',
    ]);
  });

  it('throws for a user with no connected Moxfield username', async () => {
    mockUserFindUnique.mockResolvedValue({ id: 'u2', name: 'Keith', moxfieldUsername: null });
    await expect(syncUserMoxfieldDecks('u2')).rejects.toThrow('no Moxfield username');
    expect(mockListDecks).not.toHaveBeenCalled();
  });

  it('returns an empty result when Moxfield reports no public decks', async () => {
    mockListDecks.mockResolvedValue([]);
    const result = await syncUserMoxfieldDecks('u1');
    expect(result).toMatchObject({ discovered: 0, imported: [], skippedLinked: [], skippedNameCollision: [], failed: [] });
    expect(mockDeckCreate).not.toHaveBeenCalled();
  });
});

describe('syncAllMoxfieldDecks', () => {
  it('syncs every user with a connected username and catches per-user failures', async () => {
    mockUserFindMany.mockResolvedValue([{ id: 'u1', name: 'A' }, { id: 'u2', name: 'B' }]);
    mockUserFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      where.id === 'u1'
        ? Promise.resolve(USER)
        : Promise.reject(new Error('DB hiccup'))
    );

    const { results, failedUsers } = await syncAllMoxfieldDecks();

    expect(results.map((r) => r.userName)).toEqual(['Amirali']);
    expect(failedUsers).toEqual([{ name: 'B', error: 'DB hiccup' }]);
  });

  it('only queries users that have a moxfieldUsername', async () => {
    mockUserFindMany.mockResolvedValue([]);
    await syncAllMoxfieldDecks();
    expect(mockUserFindMany).toHaveBeenCalledWith({
      where: { moxfieldUsername: { not: null } },
      select: { id: true, name: true },
    });
  });
});
