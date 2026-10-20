-- 2026-10-18: Moxfield account connection
-- users.moxfield_username  — the Moxfield account a user connected (nullable,
--   unique). Drives nightly public-deck auto-sync for that user.
-- decks.moxfield_public_id — dedupe key linking a Deck row to the Moxfield
--   deck it was imported from, so auto-sync never creates duplicates.
--
-- Additive only; existing rows stay NULL (multiple NULLs are fine under
-- SQLite unique indexes). Re-running is safe — the only errors are benign
-- "duplicate column name" / "index already exists" notices.

ALTER TABLE "users" ADD COLUMN "moxfieldUsername" TEXT;
CREATE UNIQUE INDEX "users_moxfieldUsername_key" ON "users"("moxfieldUsername");

ALTER TABLE "decks" ADD COLUMN "moxfieldPublicId" TEXT;
CREATE UNIQUE INDEX "decks_moxfieldPublicId_key" ON "decks"("moxfieldPublicId");
