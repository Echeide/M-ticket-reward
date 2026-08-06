CREATE TABLE admin_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('SUPERADMIN', 'ADMIN')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ
);

CREATE INDEX admin_users_active_email_idx ON admin_users (active, email);

CREATE TABLE admin_user_audit_log (
  id UUID PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL CHECK (action IN ('BOOTSTRAPPED', 'CREATED', 'DELETED')),
  manager_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
