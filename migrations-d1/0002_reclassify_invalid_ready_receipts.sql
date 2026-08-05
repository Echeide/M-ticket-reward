-- READY_FOR_CONFIRMATION must mean that every automatic prerequisite passed.
-- Older OCR jobs only checked isReceipt, so first resolve their recognized store
-- and then reject rows that cannot be confirmed successfully.

UPDATE receipts
SET status = 'NOT_A_RECEIPT',
    validation_reasons = '["NOT_A_RECEIPT"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND json_extract(ocr_payload, '$.isReceipt') = 0;

UPDATE receipts
SET store_id = COALESCE((
      SELECT stores.id
      FROM stores
      WHERE stores.active = 1
        AND trim(COALESCE(receipts.store_name, '')) <> ''
        AND (
          instr(lower(trim(stores.name)), lower(trim(receipts.store_name))) > 0
          OR instr(lower(trim(receipts.store_name)), lower(trim(stores.name))) > 0
          OR EXISTS (
            SELECT 1
            FROM json_each(stores.aliases) AS alias
            WHERE instr(lower(trim(CAST(alias.value AS TEXT))), lower(trim(receipts.store_name))) > 0
               OR instr(lower(trim(receipts.store_name)), lower(trim(CAST(alias.value AS TEXT)))) > 0
          )
        )
      ORDER BY stores.name ASC
      LIMIT 1
    ), store_id),
    store_name = COALESCE((
      SELECT stores.name
      FROM stores
      WHERE stores.active = 1
        AND trim(COALESCE(receipts.store_name, '')) <> ''
        AND (
          instr(lower(trim(stores.name)), lower(trim(receipts.store_name))) > 0
          OR instr(lower(trim(receipts.store_name)), lower(trim(stores.name))) > 0
          OR EXISTS (
            SELECT 1
            FROM json_each(stores.aliases) AS alias
            WHERE instr(lower(trim(CAST(alias.value AS TEXT))), lower(trim(receipts.store_name))) > 0
               OR instr(lower(trim(receipts.store_name)), lower(trim(CAST(alias.value AS TEXT)))) > 0
          )
        )
      ORDER BY stores.name ASC
      LIMIT 1
    ), store_name),
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION';

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["STORE_NOT_ALLOWED"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND store_id IS NULL;

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["TICKET_NUMBER_REQUIRED"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND trim(COALESCE(ticket_number, '')) = '';

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["INVALID_TOTAL"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND COALESCE(total_cents, 0) <= 0;

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["INVALID_DATE"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND (
    purchase_date IS NULL
    OR purchase_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR date(purchase_date, '+0 days') IS NULL
    OR date(purchase_date, '+0 days') <> purchase_date
  );

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["FUTURE_DATE"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND date(purchase_date) > date('now', '+3 days');

UPDATE receipts
SET status = 'AUTO_REJECTED',
    validation_reasons = '["TICKET_TOO_OLD"]',
    updated_at = CURRENT_TIMESTAMP
WHERE status = 'READY_FOR_CONFIRMATION'
  AND date(purchase_date) < date('now', '-3 days');

UPDATE receipts AS candidate
SET status = 'DUPLICATE',
    ticket_fingerprint = NULL,
    validation_reasons = '["DUPLICATE"]',
    updated_at = CURRENT_TIMESTAMP
WHERE candidate.status = 'READY_FOR_CONFIRMATION'
  AND EXISTS (
    SELECT 1
    FROM receipts AS original
    WHERE original.id <> candidate.id
      AND original.user_ref = candidate.user_ref
      AND original.store_id = candidate.store_id
      AND upper(trim(original.ticket_number)) = upper(trim(candidate.ticket_number))
      AND original.purchase_date = candidate.purchase_date
      AND original.total_cents = candidate.total_cents
      AND upper(original.currency) = upper(candidate.currency)
      AND original.status IN (
        'READY_FOR_CONFIRMATION', 'REWARD_PENDING', 'REWARDED',
        'REWARD_FAILED', 'REVOKE_PENDING'
      )
      AND (
        original.created_at < candidate.created_at
        OR (original.created_at = candidate.created_at AND original.id < candidate.id)
      )
  );
