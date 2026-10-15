BEGIN;
-- One resumable sweep per changed opening. Cursors use review creation order, never message
-- time, so malformed or old message dates cannot starve later eligible reviews.
CREATE TABLE review_reconciliation_jobs (
  user_id uuid NOT NULL REFERENCES ledger_users(id) ON DELETE CASCADE,
  job_opening_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  through_created_at timestamptz NOT NULL DEFAULT now(),
  last_created_at timestamptz,
  last_review_id uuid,
  PRIMARY KEY(user_id,job_opening_id),
  FOREIGN KEY(job_opening_id,user_id) REFERENCES job_openings(id,user_id) ON DELETE CASCADE,
  CHECK((last_created_at IS NULL)=(last_review_id IS NULL))
);
CREATE INDEX idx_review_reconciliation_ready ON review_reconciliation_jobs(requested_at,user_id,job_opening_id);
CREATE INDEX idx_reviews_reconciliation_cursor ON review_items(user_id,created_at,id)
  WHERE state='OPEN' AND reason_code IN ('NO_KNOWN_SUBMISSION','AMBIGUOUS_ATTEMPT','MISSING_JOB_DETAILS');
COMMIT;
