ALTER TABLE stores ADD COLUMN ocr_profile TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ocr_profile));
