// Fetches a public Moxfield deck by share URL and converts its boards to the
// Moxfield plaintext our import pipeline already parses ("1 Name (SET) 123").
// All HTTP goes through the shared moxfieldApi client (ScraperAPI in prod /
// curl locally) — Cloudflare blocks plain Node fetch on api2 by TLS fingerprint.
import { fetchMoxfieldApi } from './moxfieldApi';

export interface FetchedMoxfieldDeck {
  id: string;
  name: string;
  format: string | null;
  commander: string | null;
  /** Plaintext per board — empty string when the board has no cards. */
  main: string;
  side: string;
  maybe: string;
}

/**
 * Accepts a full share URL (https://moxfield.com/decks/<id>[-slug]) or a bare
 * deck ID. Returns null when no plausible ID is found.
 */
export function parseMoxfieldDeckId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{4,64}$/.test(trimmed) && !trimmed.includes(' ')) return trimmed;
  return null;
}

interface BoardEntry {
  quantity?: number;
  finish?: string;
  card?: { name?: string; set?: string; cn?: string; collector_number?: string };
}

// Boards come in three shapes across Moxfield's API versions: a flat map of
// entries (v2/view), { count, cards: {…} } (v3), or an array. Be liberal.
function boardEntries(board: unknown): BoardEntry[] {
  if (!board || typeof board !== 'object') return [];
  const container = board as { cards?: unknown };
  const source =
    container.cards && typeof container.cards === 'object' && !Array.isArray(container.cards)
      ? container.cards
      : board;
  const values = Array.isArray(source) ? source : Object.values(source as Record<string, unknown>);
  return values.filter((v): v is BoardEntry => !!v && typeof v === 'object' && !Array.isArray(v));
}

function boardToText(board: unknown): string {
  return boardEntries(board)
    .map((e) => {
      const qty = typeof e.quantity === 'number' && e.quantity > 0 ? e.quantity : 1;
      const name = e.card?.name?.trim();
      if (!name) return null;
      const set = e.card?.set?.toUpperCase();
      const cn = e.card?.cn ?? e.card?.collector_number;
      const finish = e.finish === 'foil' ? ' *F*' : '';
      return set && cn ? `${qty} ${name} (${set}) ${cn}${finish}` : `${qty} ${name}${finish}`;
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** Injectable so tests can stub the network without spawning curl. */
export type MoxfieldApiFetcher = (pathAndQuery: string) => Promise<unknown>;

export async function fetchMoxfieldDeck(
  urlOrId: string,
  apiFetcher: MoxfieldApiFetcher = fetchMoxfieldApi
): Promise<FetchedMoxfieldDeck> {
  const id = parseMoxfieldDeckId(urlOrId);
  if (!id) throw new Error('That does not look like a Moxfield deck URL or ID');

  // Don't let a hung upstream hold the serverless function open.
  let data: Record<string, unknown>;
  try {
    data = (await Promise.race([
      apiFetcher(`/v3/decks/all/${id}`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), 15_000)
      ),
    ])) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '__timeout__') {
      throw new Error('Moxfield took too long — try again or paste the list manually');
    }
    if (/404/.test(message)) throw new Error('Deck not found — is the Moxfield link public?');
    const status = message.match(/\b(4\d\d|5\d\d)\b/)?.[1];
    throw new Error(
      status
        ? `Moxfield returned ${status} — try again or paste the list manually`
        : 'Moxfield is blocking the request right now — try again or paste the list manually'
    );
  }
  if (!data || typeof data !== 'object') throw new Error('Moxfield returned an unexpected response');

  // v3 nests boards under `boards`; fall back to the old flat shape so a
  // hypothetical rollback of Moxfield's API doesn't break imports.
  const boards = (data.boards && typeof data.boards === 'object' ? data.boards : data) as Record<string, unknown>;

  // The view API nests boards under mainboard/sideboard/maybeboard; accept the
  // short aliases too. Commanders board holds 1-2 entries for Commander decks.
  // The v3 API nests boards under boards.mainboard etc.; the fallbacks cover
  // the legacy flat response. Commanders board holds 1-2 entries for Commander decks.
  const main = boardToText(boards.mainboard ?? data.main);
  const commanderEntry = boardEntries(boards.commanders)[0]?.card?.name?.trim() ?? null;

  return {
    id,
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Imported deck',
    format: typeof data.format === 'string' && data.format.trim() ? data.format.trim() : null,
    commander: commanderEntry,
    main,
    side: boardToText(boards.sideboard ?? data.side),
    maybe: boardToText(boards.maybeboard ?? data.maybe),
  };
}
