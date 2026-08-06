ALTER TABLE user_bans ADD COLUMN ban_threshold INTEGER;

CREATE TABLE user_upload_counters (
  external_user_id UUID NOT NULL REFERENCES external_users(id),
  campaign_key TEXT NOT NULL,
  upload_count INTEGER NOT NULL DEFAULT 0 CHECK (upload_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (external_user_id, campaign_key)
);

CREATE INDEX receipts_user_store_daily_idx
  ON receipts (external_user_id, store_id, created_at, status);
CREATE INDEX user_offenses_user_category_idx
  ON user_offenses (external_user_id, category, active, created_at DESC);
