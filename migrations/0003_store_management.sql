CREATE TABLE store_audit_log (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES stores(id),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED')),
  manager_email TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX store_audit_log_store_idx ON store_audit_log (store_id, created_at DESC);
