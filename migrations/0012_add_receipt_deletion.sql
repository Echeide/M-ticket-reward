ALTER TABLE receipts ADD COLUMN deletion_requested_at TIMESTAMPTZ;
ALTER TABLE receipts ADD COLUMN deletion_requested_by TEXT;

CREATE TABLE receipt_deletion_audit (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL UNIQUE,
  public_id TEXT NOT NULL,
  manager_email TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
