CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

CREATE TABLE app_setting_audit_log (
  id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL,
  manager_email TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX app_setting_audit_key_created_idx
  ON app_setting_audit_log(setting_key, created_at DESC);
