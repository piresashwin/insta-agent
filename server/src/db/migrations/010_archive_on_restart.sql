-- Soft-archive slides/iterations on restart instead of hard DELETE.
ALTER TABLE post_slides ADD COLUMN archived_at TEXT;
ALTER TABLE iterations ADD COLUMN archived_at TEXT;
