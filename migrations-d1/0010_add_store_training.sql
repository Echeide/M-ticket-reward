PRAGMA foreign_keys = ON;

CREATE TABLE store_training_samples (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  image_key TEXT NOT NULL UNIQUE,
  image_content_type TEXT NOT NULL,
  image_size INTEGER NOT NULL,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  expected_ticket_number TEXT NOT NULL,
  expected_purchase_date TEXT NOT NULL,
  expected_total_cents INTEGER NOT NULL,
  expected_currency TEXT NOT NULL DEFAULT 'EUR',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX store_training_samples_store_idx
  ON store_training_samples(store_id, created_at DESC);

CREATE TABLE store_training_evaluations (
  id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL REFERENCES store_training_samples(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'ERROR')),
  actual_payload TEXT,
  matches TEXT NOT NULL DEFAULT '{}',
  verification_issues TEXT NOT NULL DEFAULT '[]',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX store_training_evaluations_sample_idx
  ON store_training_evaluations(sample_id, created_at DESC);
