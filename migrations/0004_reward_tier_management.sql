CREATE TABLE reward_tier_audit_log (
  id UUID PRIMARY KEY,
  reward_tier_id UUID NOT NULL REFERENCES reward_tiers(id),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED')),
  manager_email TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX reward_tier_audit_log_tier_idx ON reward_tier_audit_log (reward_tier_id, created_at DESC);
