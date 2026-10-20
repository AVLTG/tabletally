# TableTally

MTG web app for a private friend group: check who owns cards from a pasted decklist (scraped Moxfield collections), search local game-store inventory (Puppeteer/fetch scrapers), track game history with stats dashboards, and manage decks + a shared card library.

Next.js 16 App Router + React 19 + TypeScript strict + Tailwind v4. Prisma 6 with the libsql driver adapter → Turso (SQLite) in prod. Deployed on Vercel with a cron sync (`vercel.json`, every other night), live at **https://tabletally.avltg.dev**. **Read `DEPLOYMENT.md` before touching deployment, env vars, or migrations** — the README's RPi/PM2 setup and root `update.sh` are legacy.

## Commands

```bash
npm run dev          # dev server (localhost:3000)
npm run build        # prisma generate && next build
npm run lint         # eslint (flat config, eslint-config-next; no Prettier)
npm test             # jest
npx jest tests/parse-deck-suffixes.test.ts   # single file
npx jest -t "pattern"                        # single test
npx tsc --noEmit     # typecheck (no script defined)
npx prisma generate  # after editing schema.prisma
npx prisma db push   # apply schema LOCALLY — never migrate dev/deploy
```

## Layout

- `src/app/` — pages; `src/app/api/**/route.ts` — one endpoint per dir
- `src/lib/` — all business logic (API routes import from lib, never the reverse); scrapers in `src/lib/scrapeLGS/` (one file per store) and `src/lib/scrapeMoxfield/`
- `src/proxy.ts` — Next 16 middleware (auth gate; see below)
- `prisma/schema.prisma` — camelCase fields `@@map`ped to snake_case tables
- `tests/` — Jest; `types/` — shared types; `docs/superpowers/` — per-feature plans/specs
- `.planning/codebase/` — architecture/conventions docs, **dated snapshots (2026-03-16), partly stale** (e.g. TESTING.md predates the 60+ Jest tests). Trust the code over these.

## Database — the big gotcha

`prisma migrate dev` / `migrate deploy` do **not** work with Turso/libsql. Schema changes:

1. Edit `prisma/schema.prisma`, `npx prisma db push` for local dev.
2. Prod: generate SQL with `npx prisma migrate diff --script` and pipe through `turso db shell <db>`, or add a file to `prisma/migrations-manual/` (idempotent SQL — re-runs must be safe). Apply **before or with** the deploy.

Other DB rules: Prisma client is a singleton in `src/lib/prisma.ts` (libsql adapter, needs `DATABASE_URL` + `DATABASE_AUTH_TOKEN`). The nightly sync only replaces `source='moxfield'` `CollectionCard` rows — manually added library cards must survive collection updates; keep that filter intact.

## Auth & proxy

`src/proxy.ts` gates everything except `PUBLIC_PREFIXES` (login, auth/invite APIs, `/api/cron`). `/admin` + `/api/admin/*` require session `role === 'ADMIN'`. Adding a public route means adding it to `PUBLIC_PREFIXES`; `/api/cron` authenticates itself via `Authorization: Bearer CRON_SECRET` in the route.

Passwords: scrypt (`node:crypto`) in Node API routes only — never hash in the proxy (Edge runtime). Sessions are HMAC-signed cookies (`src/lib/auth.ts`). Zod validation lives in `src/lib/validators.ts` / `authValidators.ts` — validate inputs there, not ad hoc in routes.

## Scraping conventions

Scraper modules start with `import "server-only"` (Jest maps this to `tests/__mocks__/server-only.ts`). Scrapers return `[]` on failure and never throw to the caller. Puppeteer browser is a singleton (`src/lib/scrapeLGS/browser.ts`); the Chromium binary downloads at runtime from `CHROMIUM_REMOTE_EXEC_PATH` (first scrape is slow). Basic lands and tokens are filtered out by scrapers/parsers — keep that behavior. Log with `console.error` for failures and `console.log` with emoji prefixes (`✓ ✗ ⚠️ ===`) per the existing style.

## Testing

Jest + ts-jest, `testEnvironment: node`, roots `tests/`. `@/*` maps to `src/*`. `jest.setup.ts` stubs `COOKIE_SECRET`/`ADMIN_PASSWORD`. API-route tests mock `src/lib/prisma.ts` — follow the existing pattern in a neighboring `tests/*.test.ts`. Run the full suite before declaring done; it's fast.

## Git & deploy workflow

Conventional commits (`fix(scope):`, `feat(scope):`, `chore:` …). Work on `fix/*` / `feat/*` / `feature/*` branches → PR to `master`; squash-merge with PR number in the subject. `develop` is staging: auto-deploys to a Vercel Preview against a Turso fork (`tabletally-dev`), Discord notifications disabled, cron prod-only. Don't push to `master`/`develop` without being asked.

## Live site (production)

Prod at https://tabletally.avltg.dev holds **real friend data** (~22 users, ~90 decks, 3k+ library cards). To inspect it, log in as `amirali` (ADMIN; lands on `/admin`) — the password is in the local gitignored `.env` as `WEBSITE_PASSWORD_AMIRALI`. Read it programmatically (e.g. parse `.env` in a script and fill the form), never print or commit it. Browse read-only: never click Sync / Delete / "Update All Collections" in the prod admin or submit any mutating form unless explicitly asked. Everything except `/login` sits behind the session cookie enforced by `src/proxy.ts`.

## Never commit

`.env`, `.env.local`, `src/lib/seedUsers.ts` (real friends' names/collection IDs — exists on disk, gitignored), `dev.db*`, `auth`/`auth-wal`. Legacy vars still present in `.env` (`GROUP_PASSWORD`, `APIFY_*`) are retired — `DEPLOYMENT.md`'s env table is the authoritative list.
