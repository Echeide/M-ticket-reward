ALTER TABLE store_training_evaluations
  ADD COLUMN context JSONB NOT NULL DEFAULT '{}'::jsonb;
