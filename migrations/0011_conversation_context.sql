BEGIN;
ALTER TABLE source_artifacts ADD COLUMN provider_thread_id text,
  ADD COLUMN message_id_key text,ADD COLUMN reply_message_keys text[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_artifacts_thread ON source_artifacts(user_id,mailbox_id,provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;
CREATE INDEX idx_artifacts_message_key ON source_artifacts(user_id,mailbox_id,message_id_key)
  WHERE message_id_key IS NOT NULL;
CREATE INDEX idx_companies_context_domain ON companies(user_id,normalized_domain) WHERE normalized_domain IS NOT NULL;
CREATE INDEX idx_companies_context_name ON companies(user_id,(regexp_replace(lower(canonical_name),'[^[:alnum:]]','','g')));
CREATE INDEX idx_openings_title_candidates ON job_openings(user_id,(lower(regexp_replace(btrim(title),'\s+',' ','g'))));
COMMIT;
