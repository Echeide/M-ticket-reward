CREATE TABLE receipt_reviews_v2 (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id),
  action TEXT NOT NULL CHECK (action IN ('REVIEWED_NO_FRAUD', 'FRAUD_REVOKED', 'REVIEW_REOPENED')),
  manager_email TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO receipt_reviews_v2 (id, receipt_id, action, manager_email, reason, created_at)
SELECT id, receipt_id, action, manager_email, reason, created_at
FROM receipt_reviews;

DROP TABLE receipt_reviews;
ALTER TABLE receipt_reviews_v2 RENAME TO receipt_reviews;

CREATE INDEX receipt_reviews_receipt_idx
  ON receipt_reviews (receipt_id, created_at DESC);
