-- Phase 2 wiring: proposed versions + approval artifact hash

CREATE TABLE IF NOT EXISTS post_proposed_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  snapshot     TEXT NOT NULL,
  run_id       INTEGER,
  actor_kind   TEXT,
  actor_name   TEXT,
  actor_client TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_proposed_post ON post_proposed_versions(post_id);

ALTER TABLE approvals ADD COLUMN artifact_hash TEXT;
