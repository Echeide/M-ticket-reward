ALTER TABLE receipts ADD COLUMN ocr_provider TEXT;
ALTER TABLE receipts ADD COLUMN ocr_model TEXT;
ALTER TABLE receipts ADD COLUMN ocr_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN ocr_duration_ms INTEGER;
ALTER TABLE receipts ADD COLUMN ocr_started_at TEXT;
ALTER TABLE receipts ADD COLUMN ocr_completed_at TEXT;
