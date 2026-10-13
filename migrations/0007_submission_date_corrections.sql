BEGIN;
CREATE TABLE submission_date_corrections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ledger_users(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  previous_submitted_at timestamptz,
  corrected_submitted_at timestamptz NOT NULL,
  event_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id,user_id) REFERENCES application_attempts(id,user_id)
);
COMMIT;
