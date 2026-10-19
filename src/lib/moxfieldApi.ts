// Shared client for Moxfield's internal (undocumented) api2 endpoints.
// Moxfield publishes no official API — these are the same calls the
// moxfield.com SPA makes, verified 2026-10-18. Public data only; the
// authenticated surface is Turnstile-gated and intentionally not used here.
import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MOXFIELD_API_BASE = "https://api2.moxfield.com";

/**
 * Fetch a Moxfield api2 endpoint. Uses ScraperAPI in production (Cloudflare
 * blocks datacenter IPs), falls back to curl locally (residential IPs pass;
 * curl's TLS fingerprint also survives where Node's fetch is rejected).
 * Throws on transport/HTTP failure — callers decide how to degrade.
 */
export async function fetchMoxfieldApi(pathAndQuery: string): Promise<unknown> {
  const targetUrl = `${MOXFIELD_API_BASE}${pathAndQuery}`;
  const scraperApiKey = process.env.SCRAPER_API_KEY;

  if (scraperApiKey) {
    const proxyUrl = `https://api.scraperapi.com?api_key=${scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ScraperAPI returned ${res.status} for ${targetUrl}: ${body}`);
    }
    return res.json();
  }

  // Local dev fallback: curl bypasses Cloudflare TLS fingerprinting that
  // blocks Node's fetch. --fail-with-body makes HTTP errors throw with the
  // status code in the message (e.g. 403/404) instead of returning an HTML
  // error page that would explode later in JSON.parse.
  const { stdout } = await execFileAsync("curl", [
    "-s",
    "--fail-with-body",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "-H", "Accept: application/json, text/plain, */*",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Referer: https://www.moxfield.com/",
    "-H", "Origin: https://www.moxfield.com",
    targetUrl,
  ]);
  return JSON.parse(stdout);
}

export interface MoxfieldUserSummary {
  userName: string;
  displayName: string;
  profileImageUrl: string | null;
}

/**
 * Look up Moxfield accounts by prefix (the SPA's user-picker endpoint).
 * Moxfield rejects filters shorter than 3 characters.
 */
export async function searchMoxfieldUsers(filter: string): Promise<MoxfieldUserSummary[]> {
  const data = (await fetchMoxfieldApi(
    `/v2/users/search?filter=${encodeURIComponent(filter)}&pageSize=8`
  )) as { data?: Array<{ userName?: unknown; displayName?: unknown; profileImageUrl?: unknown }> };

  return (data.data ?? [])
    .filter((u): u is { userName: string; displayName?: unknown; profileImageUrl?: unknown } =>
      typeof u.userName === "string" && u.userName.length > 0)
    .map((u) => ({
      userName: u.userName,
      displayName: typeof u.displayName === "string" && u.displayName ? u.displayName : u.userName,
      profileImageUrl: typeof u.profileImageUrl === "string" ? u.profileImageUrl : null,
    }));
}

export interface MoxfieldDeckSummary {
  publicId: string;
  name: string;
}

/**
 * List a user's PUBLIC Moxfield decks, newest first. Private decks are
 * invisible without login, so auto-sync only ever sees public ones.
 */
export async function listMoxfieldDecksByUsername(
  username: string,
  maxPages = 5
): Promise<MoxfieldDeckSummary[]> {
  const decks: MoxfieldDeckSummary[] = [];
  let pageNumber = 1;
  let totalPages = 1;

  do {
    const data = (await fetchMoxfieldApi(
      `/v2/decks/search?authorUserNames=${encodeURIComponent(username)}` +
        `&pageNumber=${pageNumber}&pageSize=100&sortType=updated&sortDirection=descending`
    )) as { totalPages?: unknown; data?: Array<Record<string, unknown>> };

    for (const raw of data.data ?? []) {
      // Search items carry deck fields at the top level today; stay liberal
      // about a nested { deck: … } wrapper in case Moxfield re-shapes it.
      const item = (raw.deck && typeof raw.deck === "object" ? raw.deck : raw) as Record<string, unknown>;
      const publicId = typeof item.publicId === "string" ? item.publicId : null;
      const name = typeof item.name === "string" ? item.name : null;
      if (publicId && name) decks.push({ publicId, name });
    }

    totalPages = typeof data.totalPages === "number" ? data.totalPages : 1;
    pageNumber++;
  } while (pageNumber <= totalPages && pageNumber <= maxPages);

  return decks;
}
