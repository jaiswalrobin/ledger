BEGIN;
-- A generation prevents overlapping search queries from requeuing the same message twice.
ALTER TABLE connected_mailboxes ADD COLUMN recheck_id uuid;
ALTER TABLE processing_tasks
  ADD COLUMN recheck_id uuid,
  ADD COLUMN reprocess_requested boolean NOT NULL DEFAULT false;
COMMIT;
