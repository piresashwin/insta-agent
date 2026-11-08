-- Phase 4 — insights tables + granted_scopes for reconnect detection.
ALTER TABLE instagram_conn ADD COLUMN granted_scopes TEXT;

CREATE TABLE IF NOT EXISTS ig_media (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL,
  post_id              INTEGER,
  media_product_type   TEXT,
  media_type           TEXT,
  permalink            TEXT,
  caption              TEXT,
  timestamp            TEXT,
  thumbnail_url        TEXT,
  is_imported          INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_ig_media_account ON ig_media(account_id);
CREATE INDEX IF NOT EXISTS idx_ig_media_post ON ig_media(post_id);

CREATE TABLE IF NOT EXISTS ig_media_metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id          TEXT NOT NULL REFERENCES ig_media(id),
  period_label      TEXT NOT NULL,
  measured_at       TEXT NOT NULL,
  views             INTEGER,
  reach             INTEGER,
  saved             INTEGER,
  shares            INTEGER,
  likes             INTEGER,
  comments          INTEGER,
  total_interactions INTEGER,
  profile_visits    INTEGER,
  follows           INTEGER,
  watch_time        INTEGER,
  raw_json          TEXT,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(media_id, period_label)
);

CREATE TABLE IF NOT EXISTS ig_account_metrics_daily (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       TEXT NOT NULL,
  date             TEXT NOT NULL,
  followers        INTEGER,
  reach            INTEGER,
  views            INTEGER,
  accounts_engaged INTEGER,
  link_taps        INTEGER,
  final            INTEGER NOT NULL DEFAULT 0,
  raw_json         TEXT,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT,
  UNIQUE(account_id, date)
);

CREATE TABLE IF NOT EXISTS ig_audience_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            TEXT NOT NULL,
  captured_at           TEXT NOT NULL,
  follower_count_at_capture INTEGER,
  demographics_json     TEXT,
  created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ig_audience_account ON ig_audience_snapshots(account_id);
