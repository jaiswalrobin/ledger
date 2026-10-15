BEGIN;
-- Calendar revisions have been linked through application_events.calendar_uid_key since 0010
-- (idx_events_calendar_revision). Nothing reads the UID from extracted_signals any more, so this
-- index only slowed signal writes.
DROP INDEX IF EXISTS idx_signals_calendar_uid;
COMMIT;
