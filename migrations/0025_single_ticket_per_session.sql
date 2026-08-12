ALTER TABLE receipts
  ADD COLUMN session_slot INTEGER NOT NULL DEFAULT 0 CHECK (session_slot IN (0, 1));

CREATE UNIQUE INDEX receipts_single_ticket_session_unique
  ON receipts (session_id)
  WHERE session_slot = 1;
