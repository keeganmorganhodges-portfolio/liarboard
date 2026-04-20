-- ============================================================
-- LiarBoard D1 Migration
-- HOW TO RUN:
--   Option A (Dashboard): Cloudflare Dashboard → D1 → your DB → Console tab
--                         Paste each statement one at a time and click Run.
--   Option B (CLI):       wrangler d1 execute <DB_NAME> --remote --file=migration.sql
--
-- SAFE TO RE-RUN: Each ALTER TABLE is wrapped so it won't crash if the
-- column already exists. D1 (SQLite) does not support ALTER TABLE ... IF NOT EXISTS,
-- so we use a workaround: try the ALTER, catch the "duplicate column" error.
-- If running via the Dashboard console, just skip any statement that errors
-- with "duplicate column name" — that just means it already ran fine before.
-- ============================================================

-- ── 1. Core people table (run once on a brand-new DB) ───────────────────────
CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  image       TEXT    NOT NULL,
  bio         TEXT,
  class       TEXT    DEFAULT 'Other',
  lvl         INTEGER DEFAULT 50,
  created_by  TEXT,
  timestamp   INTEGER DEFAULT (strftime('%s','now') * 1000)
);

-- ── 2. New LiarBoard columns ─────────────────────────────────────────────────
-- Run each line separately in the Dashboard console.
-- Skip any that error with "duplicate column name" — that's fine.
ALTER TABLE people ADD COLUMN claim         TEXT;
ALTER TABLE people ADD COLUMN truth         TEXT;
ALTER TABLE people ADD COLUMN sources       TEXT;
ALTER TABLE people ADD COLUMN debunk_count  INTEGER DEFAULT 0;
ALTER TABLE people ADD COLUMN last_corrected INTEGER;

-- ── 3. Admin users table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'sub'
);

-- ── 4. Site metadata (version control) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_metadata (
  id             INTEGER PRIMARY KEY,
  version_number REAL    NOT NULL DEFAULT 1.0
);
-- Seed the first row if it doesn't exist
INSERT OR IGNORE INTO site_metadata (id, version_number) VALUES (1, 1.0);

-- ── 5. Optional: messages table (for future inbox feature) ──────────────────
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sender    TEXT,
  receiver  TEXT,
  body      TEXT,
  timestamp INTEGER DEFAULT (strftime('%s','now') * 1000)
);

-- ── 6. Indexes for faster queries ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_people_timestamp     ON people (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_people_class         ON people (class);
CREATE INDEX IF NOT EXISTS idx_people_debunk_count  ON people (debunk_count DESC);
CREATE INDEX IF NOT EXISTS idx_people_last_corrected ON people (last_corrected DESC);

-- ── Verification query (run to confirm everything looks right) ───────────────
-- SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name;
