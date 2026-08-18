CREATE TABLE user_reward_point_claims (
  receipt_id TEXT PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL REFERENCES external_users(id),
  campaign_key TEXT NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX user_reward_point_claims_campaign_idx
  ON user_reward_point_claims (external_user_id, campaign_key);
