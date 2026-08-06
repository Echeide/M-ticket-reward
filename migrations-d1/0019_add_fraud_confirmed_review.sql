CREATE TABLE receipt_reviews_v5 (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  action TEXT NOT NULL CHECK (action IN ('REVIEWED_NO_FRAUD', 'FRAUD_REVOKED', 'REVIEW_REOPENED', 'MANUALLY_APPROVED', 'REJECTION_CONFIRMED', 'FRAUD_CONFIRMED')),
  manager_email TEXT NOT NULL,
  reason TEXT,
  changes TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(changes)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO receipt_reviews_v5 (id, receipt_id, action, manager_email, reason, changes, created_at)
SELECT id, receipt_id, action, manager_email, reason, changes, created_at FROM receipt_reviews;

DROP TABLE receipt_reviews;
ALTER TABLE receipt_reviews_v5 RENAME TO receipt_reviews;
CREATE INDEX receipt_reviews_receipt_idx ON receipt_reviews (receipt_id, created_at DESC);
