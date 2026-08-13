CREATE TABLE active_player_sessions (
  external_user_id TEXT PRIMARY KEY REFERENCES external_users(id),
  session_id TEXT NOT NULL UNIQUE REFERENCES player_sessions(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO active_player_sessions (external_user_id, session_id)
SELECT external_user.id, (
  SELECT session.id
    FROM player_sessions session
   WHERE session.external_user_id = external_user.id
     AND session.expires_at > CURRENT_TIMESTAMP
   ORDER BY session.created_at DESC, session.id DESC
   LIMIT 1
)
FROM external_users external_user
WHERE EXISTS (
  SELECT 1 FROM player_sessions session
   WHERE session.external_user_id = external_user.id
     AND session.expires_at > CURRENT_TIMESTAMP
);

ALTER TABLE receipts
  ADD COLUMN reward_session_id TEXT REFERENCES player_sessions(id);

CREATE UNIQUE INDEX receipts_reward_session_unique
  ON receipts (reward_session_id)
  WHERE reward_session_id IS NOT NULL;
