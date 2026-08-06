CREATE TABLE user_bans (
  id TEXT PRIMARY KEY,
  external_user_id TEXT NOT NULL UNIQUE REFERENCES external_users(id),
  status TEXT NOT NULL DEFAULT 'MONITORING' CHECK (status IN ('MONITORING', 'ACTIVE', 'LIFTING', 'LIFTED')),
  offense_score INTEGER NOT NULL DEFAULT 0 CHECK (offense_score >= 0),
  reason TEXT,
  banned_at TEXT,
  banned_by TEXT,
  lifting_at TEXT,
  lifting_by TEXT,
  lifted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX user_bans_status_idx ON user_bans (status, banned_at DESC);

CREATE TABLE user_offenses (
  id TEXT PRIMARY KEY,
  external_user_id TEXT NOT NULL REFERENCES external_users(id),
  receipt_id TEXT NOT NULL,
  receipt_public_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('NOT_A_RECEIPT', 'CONFIRMED_FRAUD')),
  score INTEGER NOT NULL CHECK (score > 0),
  source TEXT NOT NULL CHECK (source IN ('AUTOMATIC', 'ADMIN')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at TEXT,
  UNIQUE (receipt_id, category)
);

CREATE INDEX user_offenses_user_idx ON user_offenses (external_user_id, active, created_at DESC);
