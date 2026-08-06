CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('SUPERADMIN', 'ADMIN')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT
);

CREATE INDEX admin_users_active_email_idx ON admin_users (active, email);

CREATE TABLE admin_user_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL CHECK (action IN ('BOOTSTRAPPED', 'CREATED', 'DELETED')),
  manager_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
