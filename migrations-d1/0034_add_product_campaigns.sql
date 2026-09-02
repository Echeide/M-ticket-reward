CREATE TABLE store_product_campaigns (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  product_terms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(product_terms)),
  required_tickets INTEGER NOT NULL CHECK (required_tickets BETWEEN 1 AND 1000),
  installation_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  max_awards_total INTEGER NOT NULL DEFAULT 0 CHECK (max_awards_total >= 0),
  activated_at TEXT,
  archived_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX store_product_campaigns_store_idx
  ON store_product_campaigns (store_id, active, archived_at, created_at);

CREATE TABLE receipt_product_matches (
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES store_product_campaigns(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL REFERENCES external_users(id),
  status TEXT NOT NULL CHECK (status IN ('MATCHED', 'NOT_MATCHED', 'FAILED')),
  confidence REAL NOT NULL DEFAULT 0,
  product_text TEXT,
  evidence_text TEXT,
  provider TEXT,
  model TEXT,
  duration_ms INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (receipt_id, campaign_id)
);

CREATE INDEX receipt_product_matches_progress_idx
  ON receipt_product_matches (campaign_id, external_user_id, status, created_at);

CREATE TABLE product_campaign_audit_log (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'ARCHIVED', 'DELETED')),
  manager_email TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX product_campaign_audit_log_campaign_idx
  ON product_campaign_audit_log (campaign_id, created_at DESC);

CREATE TABLE collection_reward_claims_v2 (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  external_user_id TEXT NOT NULL REFERENCES external_users(id),
  receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES store_product_campaigns(id) ON DELETE SET NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('MILESTONE', 'DAILY_WINNER', 'PRODUCT_CAMPAIGN')),
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

INSERT INTO collection_reward_claims_v2
  (id, store_id, external_user_id, receipt_id, rule_type, rule_key, period_key,
   installation_id, family_id, requested_card_id, status, idempotency_key,
   rtales_result_id, rtales_reversal_id, awarded_card_ids, attempt_count,
   next_attempt_at, locked_until, last_error, created_at, delivered_at, revoked_at, updated_at)
SELECT id, store_id, external_user_id, receipt_id, rule_type, rule_key, period_key,
       installation_id, family_id, requested_card_id, status, idempotency_key,
       rtales_result_id, rtales_reversal_id, awarded_card_ids, attempt_count,
       next_attempt_at, locked_until, last_error, created_at, delivered_at, revoked_at, updated_at
  FROM collection_reward_claims;

DROP TABLE collection_reward_claims;
ALTER TABLE collection_reward_claims_v2 RENAME TO collection_reward_claims;

CREATE INDEX collection_reward_claims_due_idx
  ON collection_reward_claims (status, next_attempt_at);
CREATE INDEX collection_reward_claims_store_idx
  ON collection_reward_claims (store_id, status, created_at);
CREATE INDEX collection_reward_claims_user_idx
  ON collection_reward_claims (external_user_id, status, created_at);
CREATE INDEX collection_reward_claims_campaign_idx
  ON collection_reward_claims (campaign_id, status, created_at);
