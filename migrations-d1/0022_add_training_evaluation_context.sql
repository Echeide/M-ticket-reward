ALTER TABLE store_training_evaluations
  ADD COLUMN context TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context));
