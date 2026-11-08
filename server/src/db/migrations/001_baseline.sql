-- Baseline schema (extracted from original db.ts inline exec)

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
  default_brand_profile_id INTEGER,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT PRIMARY KEY,
  conn_id     INTEGER NOT NULL,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conn_id     INTEGER,
  event       TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT,
  brand_profile_id INTEGER,
  status          TEXT NOT NULL DEFAULT 'draft',
  version         INTEGER NOT NULL DEFAULT 1,
  format          TEXT,
  topic           TEXT,
  hook            TEXT,
  hook_alternates TEXT,
  caption         TEXT,
  hashtags        TEXT,
  alt_text        TEXT,
  image_prompt    TEXT,
  reel_prompt     TEXT,
  image_url       TEXT,
  reel_url        TEXT,
  source_image_url TEXT,
  canvas_json     TEXT,
  media_type      TEXT,
  media_provider  TEXT,
  media_qa        TEXT,
  background_style TEXT,
  reel_quality    TEXT,
  stock_search_query TEXT,
  prompt_vars     TEXT,
  angle           TEXT,
  pillar          TEXT,
  brand_overrides TEXT,
  scheduled_at    TEXT,
  instagram_media_id TEXT,
  instagram_creation_id TEXT,
  instagram_permalink TEXT,
  instagram_shortcode TEXT,
  instagram_published_at TEXT,
  instagram_children_ids TEXT,
  approved_by     TEXT,
  approved_at     TEXT,
  revisions       INTEGER NOT NULL DEFAULT 0,
  revision_comments TEXT,
  agent_output    TEXT,
  error           TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT
);

CREATE TABLE IF NOT EXISTS iterations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  post_version INTEGER,
  target     TEXT,
  author     TEXT NOT NULL,
  comment    TEXT NOT NULL,
  resolved_in_version INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS learn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  account_id TEXT,
  engagement TEXT,
  hook       TEXT,
  caption    TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skill_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER,
  job_id       INTEGER,
  skill        TEXT NOT NULL,
  prompt_ref   TEXT,
  provider     TEXT,
  model        TEXT,
  input        TEXT,
  output       TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_usd     REAL,
  duration_ms  INTEGER,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER,
  goal        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'agent',
  status      TEXT NOT NULL DEFAULT 'running',
  actor_kind  TEXT,
  actor_name  TEXT,
  actor_client TEXT,
  model       TEXT,
  error       TEXT,
  started_at  TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

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

CREATE TABLE IF NOT EXISTS post_slides (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id          INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  source_image_url TEXT,
  canvas_json      TEXT,
  staged_url       TEXT,
  text             TEXT,
  image_prompt     TEXT,
  stock_search_query TEXT,
  alt_text         TEXT,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT,
  UNIQUE (post_id, position),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE INDEX IF NOT EXISTS idx_post_slides_post_id ON post_slides(post_id);

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
  voice_rules TEXT,
  examples TEXT,
  example_posts TEXT,
  hashtag_sets TEXT,
  visual TEXT,
  visual_identity TEXT,
  default_background_style TEXT,
  default_format TEXT,
  default_max_slides INTEGER,
  format_mix TEXT,
  guide_md TEXT,
  timezone TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_bump_revisions
AFTER INSERT ON iterations
WHEN NEW.post_id IN (SELECT id FROM posts)
BEGIN
  UPDATE posts SET revisions = revisions + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.post_id;
END;
