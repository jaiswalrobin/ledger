BEGIN;
CREATE INDEX idx_sync_runs_latest ON sync_runs(mailbox_id,started_at DESC,id);
CREATE INDEX idx_tasks_read_state ON processing_tasks(mailbox_id,state);
CREATE INDEX idx_tasks_excluded_order ON processing_tasks(mailbox_id,finished_at DESC,id) WHERE state='DONE';
CREATE INDEX idx_attempts_application_id ON application_attempts(user_id,external_application_id) WHERE external_application_id IS NOT NULL;
CREATE INDEX idx_events_upcoming ON application_events(user_id,scheduled_for) WHERE review_state='ACCEPTED' AND scheduled_for IS NOT NULL;
COMMIT;
