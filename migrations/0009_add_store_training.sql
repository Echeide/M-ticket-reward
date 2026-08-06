CREATE TABLE store_training_samples (
  id UUID PRIMARY KEY,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  image_key TEXT NOT NULL UNIQUE,
  image_content_type TEXT NOT NULL,
  image_size INTEGER NOT NULL,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  expected_ticket_number TEXT NOT NULL,
  expected_purchase_date DATE NOT NULL,
  expected_total_cents INTEGER NOT NULL,
  expected_currency TEXT NOT NULL DEFAULT 'EUR',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX store_training_samples_store_idx
  ON store_training_samples(store_id, created_at DESC);

CREATE TABLE store_training_evaluations (
  id UUID PRIMARY KEY,
  sample_id UUID NOT NULL REFERENCES store_training_samples(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'ERROR')),
  actual_payload JSONB,
  matches JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX store_training_evaluations_sample_idx
  ON store_training_evaluations(sample_id, created_at DESC);
