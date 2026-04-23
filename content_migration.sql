-- ============================================================
-- LiarBoard D1 Migration v2
-- HOW TO RUN:
--   Dashboard: Cloudflare → D1 → your DB → Console tab
--              Paste each statement ONE AT A TIME and click Run.
--              Skip any that say "duplicate column name" — that just
--              means it already ran before. That is fine.
--   CLI:       wrangler d1 execute <DB_NAME> --remote --file=migration.sql
-- ============================================================

-- ── 1. Core people table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  image           TEXT    NOT NULL DEFAULT '',
  bio             TEXT,
  claim           TEXT,
  truth           TEXT,
  sources         TEXT,
  class           TEXT    NOT NULL DEFAULT 'Other',
  lvl             INTEGER NOT NULL DEFAULT 50,
  debunk_count    INTEGER NOT NULL DEFAULT 0,
  last_corrected  INTEGER,
  created_by      TEXT,
  timestamp       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- ── 2. Add columns if upgrading from the old schema ──────────────────────────
-- Run each individually. Skip any "duplicate column name" errors.
ALTER TABLE people ADD COLUMN claim          TEXT;
ALTER TABLE people ADD COLUMN truth          TEXT;
ALTER TABLE people ADD COLUMN sources        TEXT;
ALTER TABLE people ADD COLUMN debunk_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN last_corrected INTEGER;

-- ── 3. Admin users ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT    NOT NULL UNIQUE,
  password TEXT    NOT NULL,
  role     TEXT    NOT NULL DEFAULT 'sub'
);

-- ── 4. Site metadata (version control) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_metadata (
  id             INTEGER PRIMARY KEY,
  version_number REAL    NOT NULL DEFAULT 1.0
);
INSERT OR IGNORE INTO site_metadata (id, version_number) VALUES (1, 1.0);

-- ── 5. Messages (optional / future) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sender    TEXT,
  receiver  TEXT,
  body      TEXT,
  timestamp INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- ── 6. Performance indexes ────────────────────────────────────────────────────
-- These are the critical ones for your new class-filtered queries.
CREATE INDEX IF NOT EXISTS idx_people_class_ts       ON people (class, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_people_class_debunk   ON people (class, debunk_count DESC);
CREATE INDEX IF NOT EXISTS idx_people_class_corrected ON people (class, last_corrected DESC);
CREATE INDEX IF NOT EXISTS idx_people_class_lvl      ON people (class, CAST(lvl AS INTEGER) DESC);
CREATE INDEX IF NOT EXISTS idx_people_timestamp      ON people (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_people_debunk         ON people (debunk_count DESC);
CREATE INDEX IF NOT EXISTS idx_people_corrected      ON people (last_corrected DESC);

-- ── Verify ───────────────────────────────────────────────────────────────────
-- SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name;

-- ── New columns for community voting (run in CONTENT DB, not USERS_DB) ────────
ALTER TABLE people ADD COLUMN community_score INTEGER DEFAULT NULL;
ALTER TABLE people ADD COLUMN vote_count      INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_people_community_score ON people (community_score DESC);
