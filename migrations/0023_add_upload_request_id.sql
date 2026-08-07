ALTER TABLE receipts ADD COLUMN upload_request_id TEXT;

CREATE UNIQUE INDEX receipts_user_upload_request_unique
  ON receipts (user_ref, upload_request_id)
  WHERE upload_request_id IS NOT NULL;
