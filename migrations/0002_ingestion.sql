-- Ledger ingestion layer: signals, durable work table, mailbox leases, audit counters.
-- Nothing here stores message bodies, raw headers or credentials in plaintext.
BEGIN;

-- Ledger login identity (Google subject), separate from any connected Gmail mailbox.
ALTER TABLE ledger_users
  ADD COLUMN login_subject text UNIQUE,
  ADD COLUMN login_email text;

-- Companies are matched per user by a normalized name key (domain is optional metadata).
ALTER TABLE companies ADD COLUMN name_key text NOT NULL;
CREATE UNIQUE INDEX unique_company_name_key ON companies (user_id, name_key);

-- Mailbox sync coordination. A lease column is used instead of advisory locks because
-- pooled (transaction-mode) connections do not keep session-level locks.
ALTER TABLE connected_mailboxes
  ADD COLUMN sync_lease_until timestamptz,
  ADD COLUMN sync_lease_owner text,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error_code text,
  -- Resumable discovery position (query index + Gmail page token). Opaque, no message data.
  ADD COLUMN scan_state jsonb;

-- Evidence provenance beyond 0001: dedupe key for the same ORIGINAL message arriving via
-- Gmail and via a forward, a redacted subject for the timeline, and the envelope's own time.
ALTER TABLE source_artifacts
  ADD COLUMN original_key text,
  ADD COLUMN subject_redacted text,
  ADD COLUMN envelope_message_at timestamptz;
CREATE INDEX idx_artifacts_original_key ON source_artifacts (user_id, original_key)
  WHERE original_key IS NOT NULL;

-- One structured, redacted signal per artifact and extractor version.
CREATE TABLE extracted_signals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ledger_users(id) ON DELETE CASCADE,
  source_artifact_id uuid NOT NULL,
  extractor_version text NOT NULL,
  event_kind text CHECK (event_kind IS NULL OR event_kind IN (
    'CONFIRMATION_RECEIVED','ASSESSMENT_INVITED','INTERVIEW_INVITED',
    'INTERVIEW_SCHEDULED','REJECTION_RECEIVED','OFFER_RECEIVED'
  )),
  -- company/title/location/ats key/job URL (no query)/applicant email/external application id.
  fields jsonb NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('HIGH','LOW')),
  processing_state text NOT NULL CHECK (processing_state IN ('APPLIED','REVIEW','DISMISSED','DUPLICATE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_artifact_id, user_id) REFERENCES source_artifacts(id, user_id),
  UNIQUE (id, user_id),
  UNIQUE (source_artifact_id, extractor_version)
);

ALTER TABLE review_items
  ADD COLUMN signal_id uuid,
  ADD COLUMN candidate_opening_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN resolution text,
  ADD FOREIGN KEY (signal_id, user_id) REFERENCES extracted_signals(id, user_id),
  ADD CONSTRAINT unique_review_per_signal UNIQUE (signal_id);

-- Event provenance and read-model fields.
ALTER TABLE application_events
  ADD COLUMN origin text NOT NULL DEFAULT 'AUTO' CHECK (origin IN ('AUTO','MANUAL'));
ALTER TABLE application_attempts
  ADD COLUMN last_activity_at timestamptz,
  ADD COLUMN projection_conflicts text[] NOT NULL DEFAULT '{}',
  -- Stable evidence keys (original message key or fingerprint) proving an actual submission.
  ADD COLUMN submission_evidence_ids text[] NOT NULL DEFAULT '{}';

-- Durable, retryable work: one row per Gmail message to inspect. Registered in the same
-- transaction that advances the mailbox cursor, so a crash can never lose a message.
CREATE TABLE processing_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ledger_users(id) ON DELETE CASCADE,
  mailbox_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','DONE','FAILED')),
  outcome text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (mailbox_id, user_id) REFERENCES connected_mailboxes(id, user_id),
  UNIQUE (mailbox_id, provider_message_id)
);
CREATE INDEX idx_tasks_pending ON processing_tasks (mailbox_id, next_attempt_at)
  WHERE state = 'PENDING';

-- Aggregate mailbox-access counters (never content).
ALTER TABLE sync_runs
  ADD COLUMN discovered_count integer NOT NULL DEFAULT 0,
  ADD COLUMN headers_inspected integer NOT NULL DEFAULT 0,
  ADD COLUMN bodies_fetched integer NOT NULL DEFAULT 0,
  ADD COLUMN skipped_sensitive integer NOT NULL DEFAULT 0,
  ADD COLUMN skipped_other integer NOT NULL DEFAULT 0,
  ADD COLUMN signals_applied integer NOT NULL DEFAULT 0,
  ADD COLUMN reviews_created integer NOT NULL DEFAULT 0,
  ADD COLUMN tasks_failed integer NOT NULL DEFAULT 0;

COMMIT;
