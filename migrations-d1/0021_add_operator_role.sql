CREATE TABLE admin_users_v2 (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('SUPERADMIN', 'ADMIN', 'OPERATOR')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT
);

INSERT INTO admin_users_v2
  (id, email, role, active, created_by, created_at, updated_at, last_accessed_at)
SELECT id, email, role, active, created_by, created_at, updated_at, last_accessed_at
FROM admin_users;

CREATE TABLE admin_user_audit_log_backup (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BOOTSTRAPPED', 'CREATED', 'DELETED')),
  manager_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_user_audit_log_backup
  (id, admin_user_id, action, manager_email, created_at)
SELECT id, admin_user_id, action, manager_email, created_at
FROM admin_user_audit_log;

DROP TABLE admin_user_audit_log;
DROP TABLE admin_users;
ALTER TABLE admin_users_v2 RENAME TO admin_users;

CREATE TABLE admin_user_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL CHECK (action IN ('BOOTSTRAPPED', 'CREATED', 'DELETED')),
  manager_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO admin_user_audit_log
  (id, admin_user_id, action, manager_email, created_at)
SELECT id, admin_user_id, action, manager_email, created_at
FROM admin_user_audit_log_backup;

DROP TABLE admin_user_audit_log_backup;

CREATE INDEX admin_users_active_email_idx ON admin_users (active, email);
