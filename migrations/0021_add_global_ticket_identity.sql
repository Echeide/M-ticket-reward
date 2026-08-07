ALTER TABLE receipts ADD COLUMN ticket_identity_key TEXT;

UPDATE receipts
SET ticket_identity_key =
  upper(replace(COALESCE(declared_store_id, store_id)::text, '-', '')) || '|' ||
  upper(replace(replace(replace(replace(replace(
    trim(COALESCE(declared_ticket_number, ticket_number)),
    ' ', ''), '/', ''), '-', ''), '.', ''), '_', ''))
WHERE COALESCE(declared_store_id, store_id) IS NOT NULL
  AND trim(COALESCE(declared_ticket_number, ticket_number, '')) <> ''
  AND (
    status IN ('READY_FOR_CONFIRMATION', 'REWARD_PENDING', 'REWARDED', 'REVOKE_PENDING', 'REVOKED')
    OR (status = 'REWARD_FAILED' AND points_awarded > 0)
  );

CREATE UNIQUE INDEX receipts_global_ticket_identity_unique
  ON receipts (ticket_identity_key)
  WHERE ticket_identity_key IS NOT NULL
    AND (
      status IN ('READY_FOR_CONFIRMATION', 'REWARD_PENDING', 'REWARDED', 'REVOKE_PENDING', 'REVOKED')
      OR (status = 'REWARD_FAILED' AND points_awarded > 0)
    );
