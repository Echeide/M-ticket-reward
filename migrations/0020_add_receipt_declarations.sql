ALTER TABLE receipts ADD COLUMN declared_store_id UUID REFERENCES stores(id);
ALTER TABLE receipts ADD COLUMN declared_ticket_number TEXT;
ALTER TABLE receipts ADD COLUMN declared_total_cents INTEGER CHECK (declared_total_cents IS NULL OR declared_total_cents > 0);

CREATE INDEX receipts_declared_store_idx
  ON receipts (declared_store_id, created_at DESC);
