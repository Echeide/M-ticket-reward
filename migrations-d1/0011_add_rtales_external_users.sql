CREATE TABLE external_users (
  id TEXT PRIMARY KEY,
  rtales_subject TEXT NOT NULL UNIQUE,
  rtales_lookup_code TEXT NOT NULL,
  rtales_lookup_code_normalized TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  language TEXT NOT NULL DEFAULT '',
  space_code TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX external_users_lookup_idx
  ON external_users (rtales_lookup_code_normalized);
CREATE INDEX external_users_lookup_code_idx ON external_users (rtales_lookup_code);
CREATE INDEX external_users_context_lookup_idx
  ON external_users (installation_id, space_code, rtales_lookup_code_normalized);

ALTER TABLE player_sessions ADD COLUMN external_user_id TEXT;
ALTER TABLE player_sessions ADD COLUMN rtales_lookup_code TEXT;
ALTER TABLE player_sessions ADD COLUMN language TEXT;
ALTER TABLE player_sessions ADD COLUMN space_code TEXT;
ALTER TABLE player_sessions ADD COLUMN installation_id TEXT;
CREATE INDEX player_sessions_external_user_idx ON player_sessions (external_user_id, created_at DESC);

ALTER TABLE receipts ADD COLUMN rtales_lookup_code_snapshot TEXT;
ALTER TABLE receipts ADD COLUMN external_user_id TEXT;
CREATE INDEX receipts_lookup_snapshot_idx ON receipts (rtales_lookup_code_snapshot);
CREATE INDEX receipts_external_user_idx ON receipts (external_user_id, created_at DESC);
