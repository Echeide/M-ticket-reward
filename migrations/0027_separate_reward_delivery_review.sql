-- A failed Rtales delivery is a technical fulfillment issue, not a new fraud decision.
-- Preserve the prior staff decision and remove legacy delivery-only cases from the
-- pending antifraud queue.
UPDATE receipts
SET review_status = 'CLEARED',
    reviewed_at = COALESCE(
      reviewed_at,
      (SELECT rr.created_at
         FROM receipt_reviews rr
        WHERE rr.receipt_id = receipts.id
          AND rr.action IN ('MANUALLY_APPROVED', 'REVIEWED_NO_FRAUD')
        ORDER BY rr.created_at DESC
        LIMIT 1),
      NOW()
    ),
    reviewed_by = COALESCE(
      reviewed_by,
      (SELECT rr.manager_email
         FROM receipt_reviews rr
        WHERE rr.receipt_id = receipts.id
          AND rr.action IN ('MANUALLY_APPROVED', 'REVIEWED_NO_FRAUD')
        ORDER BY rr.created_at DESC
        LIMIT 1),
      'SYSTEM'
    ),
    updated_at = NOW()
WHERE status = 'REWARD_FAILED'
  AND review_status = 'PENDING'
  AND validation_reasons ?| ARRAY['RTALES_DELIVERY_FAILED', 'RTALES_DELIVERY_TIMEOUT'];
