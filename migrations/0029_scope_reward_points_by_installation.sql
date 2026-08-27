ALTER TABLE user_reward_point_claims
  ADD COLUMN installation_id TEXT NOT NULL DEFAULT '';

UPDATE user_reward_point_claims AS claims
SET installation_id = COALESCE((
  SELECT sessions.installation_id
  FROM receipts
  JOIN player_sessions AS sessions ON sessions.id = receipts.session_id
  WHERE receipts.id = claims.receipt_id
  LIMIT 1
), '');

DROP INDEX IF EXISTS user_reward_point_claims_campaign_idx;
CREATE INDEX user_reward_point_claims_campaign_idx
  ON user_reward_point_claims (external_user_id, installation_id, campaign_key);
