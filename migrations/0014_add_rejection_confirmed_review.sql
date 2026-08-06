ALTER TABLE receipt_reviews DROP CONSTRAINT receipt_reviews_action_check;
ALTER TABLE receipt_reviews ADD CONSTRAINT receipt_reviews_action_check
  CHECK (action IN ('REVIEWED_NO_FRAUD', 'FRAUD_REVOKED', 'REVIEW_REOPENED', 'MANUALLY_APPROVED', 'REJECTION_CONFIRMED'));
