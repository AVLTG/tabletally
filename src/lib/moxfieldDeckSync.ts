// Auto-sync a user's PUBLIC Moxfield decks into TableTally Deck rows.
// Mirrors the manual import pipeline (parse → classify against library →
// create) with one deliberate difference: cards missing from the owner's
// library are left OUT of the deck and reported, never auto-added —
// auto-sync must not mutate the library on its own.
import "server-only";
import { prisma } from "./prisma";
import { listMoxfieldDecksByUsername, type MoxfieldDeckSummary } from "./moxfieldApi";
import { fetchMoxfieldDeck, type FetchedMoxfieldDeck } from "./moxfieldDeckFetch";
import {
  parseMoxfieldText,
  buildLibraryNameIndex,
  normalizeCardName,
  type LibraryNameIndex,
  type ParsedMoxfieldCard,
} from "./parseMoxfield";
import { classifyMoxfieldCards } from "./deckImport";
import { enrichDeckCards } from "./deckEnrich";

export interface SyncedDeck {
  id: string;
  name: string;
  /** Card names left out because they are not in the owner's library. */
  excludedCards: string[];
}

export interface UserDeckSyncResult {
  userName: string;
  discovered: number;
  imported: SyncedDeck[];
  /** Already tracked — linked by moxfieldPublicId on a previous sync/import. */
  skippedLinked: string[];
  /** A deck with this name already exists (e.g. imported manually earlier). */
  skippedNameCollision: string[];
  failed: Array<{ name: string; error: string }>;
}

interface DeckCardDraft {
  cardName: string;
  quantity: number;
  set?: string;
  collectorNumber?: string;
  isFoil: boolean;
  board: string;
}

function buildDeckCardDrafts(
  fetched: FetchedMoxfieldDeck,
  libIndex: LibraryNameIndex
): { drafts: DeckCardDraft[]; excluded: string[] } {
  const drafts = new Map<string, DeckCardDraft>();
  const excluded: string[] = [];

  const add = (board: string, cardName: string, c: ParsedMoxfieldCard) => {
    const key = `${normalizeCardName(cardName)}:${board}`;
    const existing = drafts.get(key);
    if (existing) existing.quantity += c.quantity;
    else drafts.set(key, { cardName, quantity: c.quantity, set: c.set, collectorNumber: c.collectorNumber, isFoil: c.isFoil, board });
  };

  for (const [board, text] of [["main", fetched.main], ["side", fetched.side], ["maybe", fetched.maybe]] as const) {
    if (!text.trim()) continue;
    const { present, missing, basics } = classifyMoxfieldCards(parseMoxfieldText(text).cards, libIndex);
    for (const { card, canonical } of present) add(board, canonical, card);
    for (const card of basics) add(board, card.name, card);
    for (const card of missing) excluded.push(card.name);
  }

  return { drafts: Array.from(drafts.values()), excluded };
}

export async function syncUserMoxfieldDecks(userId: string): Promise<UserDeckSyncResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");
  const username = user.moxfieldUsername;
  if (!username) throw new Error("User has no Moxfield username connected");

  const result: UserDeckSyncResult = {
    userName: user.name,
    discovered: 0,
    imported: [],
    skippedLinked: [],
    skippedNameCollision: [],
    failed: [],
  };

  // Throws on Moxfield/network failure — the caller decides 502 vs per-user log
  const discovered: MoxfieldDeckSummary[] = await listMoxfieldDecksByUsername(username);
  result.discovered = discovered.length;
  if (discovered.length === 0) return result;

  const linked = await prisma.deck.findMany({
    where: { moxfieldPublicId: { in: discovered.map((d) => d.publicId) } },
    select: { moxfieldPublicId: true },
  });
  const linkedIds = new Set(linked.map((d) => d.moxfieldPublicId));

  const mine = await prisma.deck.findMany({ where: { ownerUserId: userId }, select: { name: true } });
  const myNames = new Set(mine.map((d) => d.name.trim().toLowerCase()));

  const lib = await prisma.collectionCard.findMany({ where: { userId }, select: { cardName: true } });
  const libIndex = buildLibraryNameIndex(lib.map((c) => c.cardName));

  console.log(`=== Moxfield deck sync for ${user.name}: ${discovered.length} public deck(s) ===`);

  for (const summary of discovered) {
    if (linkedIds.has(summary.publicId)) {
      result.skippedLinked.push(summary.name);
      continue;
    }
    const fallbackName = summary.name.trim() || "Moxfield deck";
    if (myNames.has(fallbackName.toLowerCase())) {
      result.skippedNameCollision.push(fallbackName);
      continue;
    }

    try {
      const fetched = await fetchMoxfieldDeck(summary.publicId);
      const name = fetched.name.trim() || fallbackName;
      if (myNames.has(name.toLowerCase())) {
        result.skippedNameCollision.push(name);
        continue;
      }

      const { drafts, excluded } = buildDeckCardDrafts(fetched, libIndex);
      const deck = await prisma.deck.create({
        data: {
          name,
          ownerUserId: userId,
          format: fetched.format,
          commander: fetched.commander,
          moxfieldPublicId: summary.publicId,
          cards: { create: drafts },
        },
      });
      myNames.add(name.toLowerCase());
      result.imported.push({ id: deck.id, name, excludedCards: excluded });
      console.log(`✓ Imported Moxfield deck "${name}" for ${user.name} (${drafts.length} rows${excluded.length ? `, ${excluded.length} cards not in library` : ""})`);

      // Best-effort mana curve data — never fails the sync.
      try {
        await enrichDeckCards(deck.id);
      } catch (error) {
        console.error("Post-sync enrich failed:", error);
      }

      // Gentle on Moxfield between deck fetches
      await new Promise((r) => setTimeout(r, 400));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`✗ Failed to import Moxfield deck ${summary.name} for ${user.name}:`, msg);
      result.failed.push({ name: summary.name, error: msg.slice(0, 200) });
    }
  }

  return result;
}

export interface AllDeckSyncResult {
  results: UserDeckSyncResult[];
  failedUsers: Array<{ name: string; error: string }>;
}

/** Nightly entry point: sync every user with a connected Moxfield account. */
export async function syncAllMoxfieldDecks(): Promise<AllDeckSyncResult> {
  const users = await prisma.user.findMany({
    where: { moxfieldUsername: { not: null } },
    select: { id: true, name: true },
  });

  const results: UserDeckSyncResult[] = [];
  const failedUsers: AllDeckSyncResult["failedUsers"] = [];

  for (let i = 0; i < users.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      results.push(await syncUserMoxfieldDecks(users[i].id));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`✗ Moxfield deck sync failed for ${users[i].name}:`, msg);
      failedUsers.push({ name: users[i].name, error: msg.slice(0, 200) });
    }
  }

  return { results, failedUsers };
}
