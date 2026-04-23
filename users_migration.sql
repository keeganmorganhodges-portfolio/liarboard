-- ============================================================
-- LiarBoard USERS_DB Migration
-- This goes in your SECOND D1 database (USERS_DB binding).
-- Run each statement one at a time in the D1 Console.
-- Skip any "duplicate column" errors — means it already ran.
-- ============================================================

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL UNIQUE,
  email           TEXT    NOT NULL UNIQUE,
  -- bcrypt-style hash stored as hex; NEVER plaintext
  password_hash   TEXT    NOT NULL,
  -- profile fields — NULL until approved by main admin
  display_name    TEXT,
  bio             TEXT,
  contact_info    TEXT,
  avatar_url      TEXT,
  -- account status
  status          TEXT    NOT NULL DEFAULT 'active',  -- active | suspended | banned
  -- per-account message send limit (NULL = use global default of 5)
  msg_daily_limit INTEGER,
  -- push notification subscription JSON
  push_sub        TEXT,
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  last_seen       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE INDEX IF NOT EXISTS idx_users_email    ON users (email);

-- ── Sessions (token-based auth, no cookies needed) ───────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,           -- 32-byte random hex
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  expires_at INTEGER NOT NULL               -- epoch ms; 30-day sessions
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions (expires_at);

-- ── Votes (one per user per person entry) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
  user_id   INTEGER NOT NULL,
  person_id INTEGER NOT NULL,               -- references people.id in content DB
  score     INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  voted_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  PRIMARY KEY (user_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_person ON votes (person_id);

-- ── Profile change requests (pending main admin approval) ────────────────────
CREATE TABLE IF NOT EXISTS profile_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  field        TEXT    NOT NULL,  -- 'display_name' | 'bio' | 'contact_info' | 'avatar_url'
  new_value    TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_by  TEXT,                                -- admin username
  submitted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  reviewed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_preq_user   ON profile_requests (user_id, status);
CREATE INDEX IF NOT EXISTS idx_preq_status ON profile_requests (status);

-- ── Messages (user-to-user DMs, D1-based, not real-time) ─────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL,
  to_id       INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  read_at     INTEGER,
  sent_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_msg_to   ON messages (to_id,   sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_from ON messages (from_id, sent_at DESC);

-- ── Message rate-limit log (one row per user per UTC day) ────────────────────
CREATE TABLE IF NOT EXISTS msg_daily (
  user_id    INTEGER NOT NULL,
  utc_day    TEXT    NOT NULL,   -- 'YYYY-MM-DD'
  sent_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, utc_day)
);

-- ── Submission requests (contact page → admin review) ────────────────────────
-- Type: 'add' | 'remove'
CREATE TABLE IF NOT EXISTS submission_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,          -- NULL if anonymous (shouldn't happen with new system)
  ip_hash      TEXT    NOT NULL, -- SHA-256 of IP — not raw IP
  type         TEXT    NOT NULL CHECK (type IN ('add','remove')),
  names        TEXT    NOT NULL, -- JSON array of names
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | reviewed | rejected
  admin_note   TEXT,
  submitted_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  reviewed_at  INTEGER,
  reviewed_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_subreq_status ON submission_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_subreq_user   ON submission_requests (user_id);

-- ── Submission rate limit (1 add + 1 remove per user+ip per day) ─────────────
CREATE TABLE IF NOT EXISTS submission_daily (
  key      TEXT    NOT NULL,   -- 'userId_ipHash_type_YYYY-MM-DD'
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key)
);

-- ── Chat queue (waiting room for live chat with main admin) ──────────────────
-- Note: live chat itself requires Durable Objects (Workers Paid plan).
-- This table manages the queue and is readable without DO.
CREATE TABLE IF NOT EXISTS chat_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  username    TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'user',  -- user | sub | main
  status      TEXT    NOT NULL DEFAULT 'waiting', -- waiting | active | done | expired
  joined_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  started_at  INTEGER,
  ended_at    INTEGER,
  time_limit  INTEGER NOT NULL DEFAULT 300  -- seconds; default 5 min
);
CREATE INDEX IF NOT EXISTS idx_cq_status ON chat_queue (status, joined_at ASC);

-- ── Push subscriptions (Web Push VAPID) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,    -- NULL = anonymous / admin device
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  label      TEXT,       -- e.g. 'main_admin_phone'
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- ── Global config (key-value for easy runtime changes) ───────────────────────
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Default config values
INSERT OR IGNORE INTO config VALUES ('msg_daily_limit',       '5');
INSERT OR IGNORE INTO config VALUES ('chat_time_limit_secs',  '300');
INSERT OR IGNORE INTO config VALUES ('chat_enabled',          'true');
INSERT OR IGNORE INTO config VALUES ('signup_enabled',        'true');
INSERT OR IGNORE INTO config VALUES ('turnstile_required',    'true');

-- ── Cached stats snapshot (updated once per day at noon CDT) ─────────────────
CREATE TABLE IF NOT EXISTS stats_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  cached_at  INTEGER NOT NULL  -- epoch ms of last update
);
INSERT OR IGNORE INTO stats_cache VALUES ('user_count', '0', 0);
