// SQLite via Node built-in `node:sqlite` (no native modules needed)
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'

const dbPath = path.join(__dirname, '..', 'content-agent.db')
if (fs.existsSync(dbPath) === false) {
  fs.writeFileSync(dbPath, '')
}
const db = new DatabaseSync(dbPath, { readOnly: false })

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Connection (one row per Instagram Business account)
CREATE TABLE IF NOT EXISTS instagram_conn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT UNIQUE NOT NULL,
  app_id        TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT,
  status        TEXT NOT NULL DEFAULT 'disconnected',
  ig_username   TEXT,
  page_id       TEXT,
  last_error    TEXT,
  token_expires_at TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT
);

-- OAuth CSRF state (one-time)
CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  conn_id     INTEGER NOT NULL,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Auth audit (no raw tokens)
CREATE TABLE IF NOT EXISTS auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id     INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Post resource + lifecycle
CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'draft',
  topic           TEXT,
  hook            TEXT,
  hook_alternates TEXT,
  caption         TEXT,
  hashtags        TEXT,
  image_prompt    TEXT,
  reel_prompt     TEXT,
  image_url       TEXT,
  reel_url        TEXT,
  media_type      TEXT,
  instagram_media_id TEXT,
  approved_by     TEXT,
  approved_at     TEXT,
  revisions       INTEGER NOT NULL DEFAULT 0,
  revision_comments TEXT,
  agent_output    TEXT,
  error           TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT
);

-- Iterations / review comments
CREATE TABLE IF NOT EXISTS iterations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id   INTEGER NOT NULL,
  author    TEXT NOT NULL,
  comment   TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Performance memory (v1: no metrics; later phases track performance)
CREATE TABLE IF NOT EXISTS learn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  account_id TEXT,
  engagement TEXT,
  hook       TEXT,
  caption    TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Skills run log (optional, for review)
CREATE TABLE IF NOT EXISTS skill_runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id   INTEGER,
  skill     TEXT NOT NULL,
  input     TEXT,
  output    TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Chapter 04: durable agent/pipeline runs (current state)
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER,
  goal        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'agent',
  status      TEXT NOT NULL DEFAULT 'running',
  model       TEXT,
  error       TEXT,
  started_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

-- Chapter 04: append-only event log per run
CREATE TABLE IF NOT EXISTS run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);

-- Slides: feed/reel = 1 row; carousel = 2–10
CREATE TABLE IF NOT EXISTS post_slides (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id          INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  source_image_url TEXT,
  canvas_json      TEXT,
  staged_url       TEXT,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT,
  UNIQUE (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE INDEX IF NOT EXISTS idx_post_slides_post_id ON post_slides(post_id);

-- Brand profiles (separate personas / niches)
CREATE TABLE IF NOT EXISTS brand_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  niche TEXT,
  audience TEXT,
  goals TEXT,
  pillars TEXT,
  posts_per_week INTEGER NOT NULL DEFAULT 3,
  preferred_days TEXT,
  voice TEXT,
  examples TEXT,
  visual TEXT,
  default_background_style TEXT,
  default_format TEXT,
  guide_md TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

-- Migrate: bump revisions counter when a revision is added
CREATE TRIGGER IF NOT EXISTS trg_bump_revisions
AFTER INSERT ON iterations
WHEN NEW.post_id IN (SELECT id FROM posts)
BEGIN
  UPDATE posts SET revisions = revisions + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.post_id;
END;
`)

// Additive migrations for existing SQLite files (CREATE TABLE IF NOT EXISTS won't alter).
for (const ddl of [
  'ALTER TABLE instagram_conn ADD COLUMN ig_username TEXT',
  'ALTER TABLE instagram_conn ADD COLUMN page_id TEXT',
  'ALTER TABLE instagram_conn ADD COLUMN last_error TEXT',
  'ALTER TABLE instagram_conn ADD COLUMN token_expires_at TEXT',
  'ALTER TABLE instagram_conn ADD COLUMN default_brand_profile_id INTEGER',
  'ALTER TABLE posts ADD COLUMN stock_search_query TEXT',
  'ALTER TABLE posts ADD COLUMN media_provider TEXT',
  'ALTER TABLE posts ADD COLUMN format TEXT',
  'ALTER TABLE posts ADD COLUMN canvas_json TEXT',
  'ALTER TABLE posts ADD COLUMN source_image_url TEXT',
  'ALTER TABLE posts ADD COLUMN background_style TEXT',
  'ALTER TABLE posts ADD COLUMN brand_profile_id INTEGER',
  'ALTER TABLE posts ADD COLUMN brand_overrides TEXT',
  'ALTER TABLE posts ADD COLUMN scheduled_at TEXT',
  'ALTER TABLE posts ADD COLUMN pillar TEXT',
]) {
  try {
    db.exec(ddl)
  } catch {
    // column already exists
  }
}

export default db
