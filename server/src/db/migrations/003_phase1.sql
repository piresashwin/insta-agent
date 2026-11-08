-- Phase 1: BrandContext v2 columns on brand_profiles
ALTER TABLE brand_profiles ADD COLUMN voice_rules TEXT;
ALTER TABLE brand_profiles ADD COLUMN example_posts TEXT;
ALTER TABLE brand_profiles ADD COLUMN hashtag_sets TEXT;
ALTER TABLE brand_profiles ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
