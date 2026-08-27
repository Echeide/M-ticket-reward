ALTER TABLE stores
  ADD COLUMN collection_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(collection_config));

ALTER TABLE receipts
  ADD COLUMN cards_awarded TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cards_awarded));

CREATE TABLE collection_reward_claims (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  external_user_id TEXT NOT NULL REFERENCES external_users(id),
  receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('MILESTONE', 'DAILY_WINNER')),
  rule_key TEXT NOT NULL,
  period_key TEXT NOT NULL DEFAULT '',
  installation_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  requested_card_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'SKIPPED', 'FAILED', 'REVOKE_PENDING', 'REVOKING', 'REVOKED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  rtales_result_id TEXT,
  rtales_reversal_id TEXT,
  awarded_card_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(awarded_card_ids)),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (store_id, external_user_id, rule_type, rule_key, period_key)
);

CREATE INDEX collection_reward_claims_due_idx
  ON collection_reward_claims (status, next_attempt_at);
CREATE INDEX collection_reward_claims_store_idx
  ON collection_reward_claims (store_id, status, created_at);
CREATE INDEX collection_reward_claims_user_idx
  ON collection_reward_claims (external_user_id, status, created_at);

CREATE TABLE collection_daily_periods (
  installation_id TEXT NOT NULL,
  category_code TEXT NOT NULL,
  period_key TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (installation_id, category_code, period_key)
);
