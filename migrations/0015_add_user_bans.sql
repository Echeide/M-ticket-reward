CREATE TABLE user_bans (
  id UUID PRIMARY KEY,
  external_user_id UUID NOT NULL UNIQUE REFERENCES external_users(id),
  status TEXT NOT NULL DEFAULT 'MONITORING' CHECK (status IN ('MONITORING', 'ACTIVE', 'LIFTING', 'LIFTED')),
  offense_score INTEGER NOT NULL DEFAULT 0 CHECK (offense_score >= 0),
  reason TEXT,
  banned_at TIMESTAMPTZ,
  banned_by TEXT,
  lifting_at TIMESTAMPTZ,
  lifting_by TEXT,
  lifted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_bans_status_idx ON user_bans (status, banned_at DESC);

CREATE TABLE user_offenses (
  id UUID PRIMARY KEY,
  external_user_id UUID NOT NULL REFERENCES external_users(id),
  receipt_id UUID NOT NULL,
  receipt_public_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('NOT_A_RECEIPT', 'CONFIRMED_FRAUD')),
  score INTEGER NOT NULL CHECK (score > 0),
  source TEXT NOT NULL CHECK (source IN ('AUTOMATIC', 'ADMIN')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  UNIQUE (receipt_id, category)
);

CREATE INDEX user_offenses_user_idx ON user_offenses (external_user_id, active, created_at DESC);
