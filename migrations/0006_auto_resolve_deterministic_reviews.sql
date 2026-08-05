UPDATE receipts
SET review_status = 'CLEARED',
    reviewed_at = COALESCE(reviewed_at, updated_at, CURRENT_TIMESTAMP),
    reviewed_by = COALESCE(reviewed_by, 'SYSTEM')
WHERE review_status = 'PENDING'
  AND status IN (
    'READY_FOR_CONFIRMATION',
    'NOT_A_RECEIPT',
    'DUPLICATE',
    'AUTO_REJECTED',
    'REWARD_PENDING',
    'REWARDED'
  );
