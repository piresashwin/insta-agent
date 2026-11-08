-- Idea → Post flow: persistent ideas backlog + posts.idea_id link.
CREATE TABLE IF NOT EXISTS ideas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_profile_id INTEGER NOT NULL,
  batch_id         TEXT,
  topic            TEXT NOT NULL,
  angle            TEXT,
  pillar           TEXT,
  format           TEXT NOT NULL DEFAULT 'feed',
  hooks_json       TEXT NOT NULL DEFAULT '[]',
  chosen_hook      TEXT,
  direction        TEXT,
  why              TEXT,
  source           TEXT NOT NULL DEFAULT 'ai',
  parent_idea_id   INTEGER,
  steer            TEXT,
  status           TEXT NOT NULL DEFAULT 'new',
  post_id          INTEGER,
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ideas_brand_status ON ideas(brand_profile_id, status);
ALTER TABLE posts ADD COLUMN idea_id INTEGER;
