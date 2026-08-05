PRAGMA foreign_keys = ON;

CREATE TABLE player_sessions (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  user_ref TEXT NOT NULL,
  rtales_game_session_id TEXT NOT NULL UNIQUE,
  player_token_encrypted TEXT NOT NULL,
  parent_origin TEXT,
  display_name TEXT,
  user_email TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX player_sessions_user_ref_idx ON player_sessions (user_ref, created_at DESC);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reward_tiers (
  id TEXT PRIMARY KEY,
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  points INTEGER NOT NULL CHECK (points >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (minimum_cents)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES player_sessions(id),
  user_ref TEXT NOT NULL,
  image_key TEXT NOT NULL UNIQUE,
  image_sha256 TEXT NOT NULL,
  image_content_type TEXT NOT NULL,
  image_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'OCR_QUEUED', 'OCR_PROCESSING', 'READY_FOR_CONFIRMATION',
    'NOT_A_RECEIPT', 'DUPLICATE', 'AUTO_REJECTED',
    'REWARD_PENDING', 'REWARDED', 'REWARD_FAILED',
    'REVOKE_PENDING', 'REVOKED'
  )),
  store_id TEXT REFERENCES stores(id),
  store_name TEXT,
  ticket_number TEXT,
  purchase_date TEXT,
  total_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  ticket_fingerprint TEXT,
  ocr_payload TEXT CHECK (ocr_payload IS NULL OR json_valid(ocr_payload)),
  ocr_confidence REAL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  validation_reasons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(validation_reasons)),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'CLEARED', 'FRAUD')),
  reviewed_at TEXT,
  reviewed_by TEXT,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  rtales_result_id TEXT,
  rtales_reversal_id TEXT,
  rewarded_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX receipts_user_fingerprint_unique
  ON receipts (user_ref, ticket_fingerprint)
  WHERE ticket_fingerprint IS NOT NULL AND status NOT IN ('AUTO_REJECTED', 'NOT_A_RECEIPT');
CREATE INDEX receipts_filters_idx ON receipts (status, store_id, purchase_date DESC);
CREATE INDEX receipts_user_idx ON receipts (user_ref, created_at DESC);
CREATE INDEX receipts_image_hash_idx ON receipts (image_sha256);

CREATE TABLE receipt_reviews (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  action TEXT NOT NULL CHECK (action IN ('REVIEWED_NO_FRAUD', 'FRAUD_REVOKED')),
  manager_email TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX receipt_reviews_receipt_idx ON receipt_reviews (receipt_id, created_at DESC);

CREATE TABLE reward_outbox (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  operation TEXT NOT NULL CHECK (operation IN ('GRANT', 'REVOKE')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  last_error TEXT,
  response_payload TEXT CHECK (response_payload IS NULL OR json_valid(response_payload)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX reward_outbox_due_idx ON reward_outbox (status, next_attempt_at);

CREATE TABLE store_audit_log (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED')),
  manager_email TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX store_audit_log_store_idx ON store_audit_log (store_id, created_at DESC);

CREATE TABLE reward_tier_audit_log (
  id TEXT PRIMARY KEY,
  reward_tier_id TEXT NOT NULL REFERENCES reward_tiers(id),
  action TEXT NOT NULL CHECK (action IN ('CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED')),
  manager_email TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX reward_tier_audit_log_tier_idx ON reward_tier_audit_log (reward_tier_id, created_at DESC);

INSERT INTO reward_tiers (id, minimum_cents, points) VALUES
  ('00000000-0000-4000-8000-000000000001', 0, 5),
  ('00000000-0000-4000-8000-000000000002', 5000, 20),
  ('00000000-0000-4000-8000-000000000003', 10000, 50);
