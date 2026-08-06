ALTER TABLE receipts ADD COLUMN deletion_requested_at TEXT;
ALTER TABLE receipts ADD COLUMN deletion_requested_by TEXT;

CREATE TABLE receipt_deletion_audit (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE,
  public_id TEXT NOT NULL,
  manager_email TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
