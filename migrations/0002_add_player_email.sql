ALTER TABLE player_sessions
  ADD COLUMN user_email TEXT;

CREATE INDEX player_sessions_user_email_idx
  ON player_sessions (LOWER(user_email))
  WHERE user_email IS NOT NULL;
