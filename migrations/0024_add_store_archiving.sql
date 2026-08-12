ALTER TABLE stores ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN archived_by TEXT;

CREATE INDEX stores_archived_status_idx
  ON stores (archived_at, active, name);
