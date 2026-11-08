-- Phase 0 additions: spend_ledger, post_reviews, post_versions, approvals, jobs

CREATE TABLE IF NOT EXISTS spend_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK(kind IN ('text','image','video')),
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  cost_usd    REAL NOT NULL,
  post_id     INTEGER,
  job_id      INTEGER,
  estimated   INTEGER NOT NULL DEFAULT 0,
  budget_scope TEXT NOT NULL DEFAULT 'prod',
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spend_ledger_created ON spend_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_spend_ledger_post ON spend_ledger(post_id);

CREATE TABLE IF NOT EXISTS post_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER NOT NULL,
  post_version   INTEGER NOT NULL DEFAULT 1,
  rubric_version INTEGER,
  judge_model    TEXT,
  scores_json    TEXT,
  items_json     TEXT,
  passed         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_reviews_post ON post_reviews(post_id);

CREATE TABLE IF NOT EXISTS post_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  actor_kind TEXT,
  actor_name TEXT,
  actor_client TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, version)
);

CREATE INDEX IF NOT EXISTS idx_post_versions_post ON post_versions(post_id);

CREATE TABLE IF NOT EXISTS approvals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL,
  version         INTEGER NOT NULL,
  stage           TEXT NOT NULL CHECK(stage IN ('copy','media')),
  decision        TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  actor_kind      TEXT,
  actor_name      TEXT,
  actor_client    TEXT,
  comment         TEXT,
  override_reason TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approvals_post ON approvals(post_id);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 0,
  run_at          TEXT DEFAULT CURRENT_TIMESTAMP,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  lease_owner     TEXT,
  lease_expires_at TEXT,
  dedupe_key      TEXT UNIQUE,
  result_json     TEXT,
  error           TEXT,
  post_id         INTEGER,
  run_id          INTEGER,
  budget_scope    TEXT NOT NULL DEFAULT 'prod',
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_post ON jobs(post_id);

CREATE TABLE IF NOT EXISTS brand_rubrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_profile_id  INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  source_hash       TEXT,
  rubric_json       TEXT NOT NULL,
  edited_by_human   INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(brand_profile_id, version)
);
