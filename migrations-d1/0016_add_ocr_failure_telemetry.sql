ALTER TABLE receipts ADD COLUMN ocr_job_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipts ADD COLUMN ocr_last_error TEXT;
