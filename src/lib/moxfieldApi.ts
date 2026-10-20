// Shared client for Moxfield's internal (undocumented) api2 endpoints.
// Moxfield publishes no official API — these are the same calls the
// moxfield.com SPA makes, verified 2026-10-18. Public data only; the
// authenticated surface is Turnstile-gated and intentionally not used here.
//
// Cloudflare blocks EVERY Node-based client (fetch/undici, https) by TLS
// fingerprint — even from residential IPs — while curl and a real Chromium
// pass. So requests go through a strategy chain:
//   1. curl          — fastest; available locally and on self-hosted boxes
//   2. real Chromium — the same @sparticuz browser the LGS scrapers ship;
//                      used on Vercel, where no curl binary exists
//   3. ScraperAPI    — optional last resort, only when SCRAPER_API_KEY is set
import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import { launchBrowser } from "@/lib/scrapeLGS/browser";

const execFileAsync = promisify(execFile);

export const MOXFIELD_API_BASE = "https://api2.moxfield.com";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

class CurlUnavailableError extends Error {
  constructor() {
    super("curl is not installed on this host");
  }
}

function isCurlUnavailable(error: unknown): boolean {
  return (
    error instanceof CurlUnavailableError ||
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** Strategy 1: curl — its TLS fingerprint passes Cloudflare where Node's never do. */
async function curlJson(targetUrl: string): Promise<unknown> {
  try {
    // --fail-with-body makes HTTP errors throw with the status in the message
    // (e.g. 403/404) instead of returning an HTML page that explodes in JSON.parse.
    const { stdout } = await execFileAsync("curl", [
      "-s",
      "--fail-with-body",
      "-H", `User-Agent: ${BROWSER_UA}`,
      "-H", "Accept: application/json, text/plain, */*",
      "-H", "Accept-Language: en-US,en;q=0.9",
      "-H", "Referer: https://www.moxfield.com/",
      "-H", "Origin: https://www.moxfield.com",
      targetUrl,
    ]);
    return JSON.parse(stdout);
  } catch (error) {
    // ENOENT = no curl binary (e.g. Vercel) → fall through to the browser.
    // Any other failure means Moxfield/CF actually answered — keep it.
    if ((error as { code?: string }).code === "ENOENT") throw new CurlUnavailableError();
    throw error;
  }
}

// One browser for all Moxfield fetches in this instance — the nightly sync
// fires dozens of requests and a fresh launch per call would be far too slow.
let browserPromise: Promise<Browser> | null = null;

async function getMoxfieldBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = null; // retry the launch next time
      throw error;
    });
  }
  return browserPromise;
}

/** Strategy 2: navigate a real Chromium page to the JSON endpoint. */
async function browserJson(targetUrl: string): Promise<unknown> {
  const browser = await getMoxfieldBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(BROWSER_UA);
    const response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (!response || !response.ok()) {
      throw new Error(
        `Moxfield returned ${response ? response.status() : "no response"} for ${targetUrl}`
      );
    }
    // Chromium renders raw JSON as text — innerText is the full payload.
    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Strategy 3 (optional): ScraperAPI proxy. */
async function scraperJson(targetUrl: string, apiKey: string): Promise<unknown> {
  const proxyUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const res = await fetch(proxyUrl);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ScraperAPI returned ${res.status} for ${targetUrl}: ${body}`);
  }
  return res.json();
}

export interface MoxfieldFetchStrategies {
  curl?: (url: string) => Promise<unknown>;
  browser?: (url: string) => Promise<unknown>;
  scraper?: (url: string, apiKey: string) => Promise<unknown>;
}

/**
 * Fetch a Moxfield api2 endpoint as parsed JSON. Throws on transport/HTTP
 * failure — callers decide how to degrade. Injectable strategies are a
 * test hook; production always uses the defaults.
 */
export async function fetchMoxfieldApi(
  pathAndQuery: string,
  strategies: MoxfieldFetchStrategies = {}
): Promise<unknown> {
  const targetUrl = `${MOXFIELD_API_BASE}${pathAndQuery}`;
  const curl = strategies.curl ?? curlJson;
  const browser = strategies.browser ?? browserJson;
  const scraper = strategies.scraper ?? scraperJson;

  try {
    return await curl(targetUrl);
  } catch (error) {
    if (!isCurlUnavailable(error)) throw error;
  }

  try {
    return await browser(targetUrl);
  } catch (browserError) {
    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) throw browserError;
    return scraper(targetUrl, apiKey);
  }
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
export async function searchMoxfieldUsers(
  filter: string,
  fetcher: (pathAndQuery: string) => Promise<unknown> = fetchMoxfieldApi
): Promise<MoxfieldUserSummary[]> {
  const data = (await fetcher(
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
  fetcher: (pathAndQuery: string) => Promise<unknown> = fetchMoxfieldApi,
  maxPages = 5
): Promise<MoxfieldDeckSummary[]> {

  const decks: MoxfieldDeckSummary[] = [];
  let pageNumber = 1;
  let totalPages = 1;

  do {
    const data = (await fetcher(
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
