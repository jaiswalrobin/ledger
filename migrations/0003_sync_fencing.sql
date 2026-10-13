BEGIN;
ALTER TABLE connected_mailboxes ADD COLUMN history_scan_state jsonb;
COMMIT;
