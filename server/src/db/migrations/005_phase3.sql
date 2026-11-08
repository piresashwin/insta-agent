-- Phase 3: Creative Studio
-- Adds scene_json to posts (supersedes canvas_json) and the assets table.

-- Scene JSON column on posts (v2 SceneDoc). canvas_json kept for backward compat.
ALTER TABLE posts ADD COLUMN scene_json TEXT;

-- Assets table: AI-generated, stock, uploaded, or rendered media files.
CREATE TABLE IF NOT EXISTS assets (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('image', 'video', 'font', 'logo', 'audio')),
  url          TEXT NOT NULL,
  w            INTEGER,
  h            INTEGER,
  -- How the asset was produced.
  source       TEXT NOT NULL CHECK (source IN ('ai', 'stock', 'upload', 'render')),
  provider     TEXT,          -- e.g. 'runware', 'pexels', 's3'
  prompt       TEXT,          -- generation prompt if ai
  sha256       TEXT,          -- content hash for dedup
  -- Optional FK to the post or brand it was generated for.
  post_id      INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  brand_id     INTEGER REFERENCES brand_profiles(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_post_id    ON assets(post_id);
CREATE INDEX IF NOT EXISTS idx_assets_brand_id   ON assets(brand_id);
CREATE INDEX IF NOT EXISTS idx_assets_kind       ON assets(kind);
