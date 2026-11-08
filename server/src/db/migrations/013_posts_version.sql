-- Backfill posts.version for DBs created before baseline included the column.
-- CREATE TABLE IF NOT EXISTS in 001_baseline.sql does not alter existing tables.
ALTER TABLE posts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
