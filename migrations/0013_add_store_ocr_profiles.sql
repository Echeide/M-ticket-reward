ALTER TABLE stores ADD COLUMN ocr_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
