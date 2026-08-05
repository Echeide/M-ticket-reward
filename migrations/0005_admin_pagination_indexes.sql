CREATE INDEX IF NOT EXISTS receipts_created_at_idx
  ON receipts (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS receipts_review_created_idx
  ON receipts (review_status, created_at DESC);
