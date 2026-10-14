BEGIN;
ALTER TABLE source_artifacts ADD COLUMN sender_domain text,ADD COLUMN sender_verified boolean NOT NULL DEFAULT false;
ALTER TABLE extracted_signals ADD CONSTRAINT unique_signal_artifact_owner UNIQUE(id,user_id,source_artifact_id);
ALTER TABLE event_evidence ADD COLUMN signal_id uuid,
  ADD FOREIGN KEY(signal_id,user_id,artifact_id) REFERENCES extracted_signals(id,user_id,source_artifact_id);

-- Infer legacy provenance only when exactly one proposal for this artifact was applied.
WITH candidates AS (
  SELECT ev.user_id,ev.event_id,ev.artifact_id,min(s.id::text)::uuid AS signal_id
  FROM event_evidence ev JOIN extracted_signals s
    ON s.user_id=ev.user_id AND s.source_artifact_id=ev.artifact_id AND s.processing_state='APPLIED'
  GROUP BY ev.user_id,ev.event_id,ev.artifact_id HAVING count(*)=1
)
UPDATE event_evidence ev SET signal_id=c.signal_id FROM candidates c
WHERE ev.user_id=c.user_id AND ev.event_id=c.event_id AND ev.artifact_id=c.artifact_id;

ALTER TABLE application_events
  ADD COLUMN calendar_uid_key text CHECK(calendar_uid_key IS NULL OR calendar_uid_key ~ '^[a-f0-9]{64}$'),
  ADD COLUMN calendar_sequence bigint CHECK(calendar_sequence >= 0 AND calendar_sequence <= 9007199254740991),
  ADD COLUMN calendar_method text,
  ADD COLUMN calendar_status text,
  ADD COLUMN calendar_organizer_domain text,
  ADD COLUMN calendar_sender_domain text,
  ADD COLUMN scheduled_for timestamptz,
  ADD CHECK((calendar_uid_key IS NULL)=(calendar_sequence IS NULL));

-- Conflicting legacy proposals remain unprojected; do not pick an arbitrary parser version.
WITH calendars AS (
  SELECT ev.event_id,(array_agg(s.fields->'calendar'))[1] AS facts
  FROM event_evidence ev JOIN extracted_signals s ON s.id=ev.signal_id AND s.user_id=ev.user_id
  JOIN application_events e ON e.id=ev.event_id AND e.user_id=ev.user_id
  WHERE e.event_kind='INTERVIEW_SCHEDULED' AND s.fields ? 'calendar'
    AND s.fields->'calendar'->>'uidKey' ~ '^[a-f0-9]{64}$'
    AND s.fields->'calendar'->>'sequence' ~ '^[0-9]{1,15}$'
    AND s.fields->'calendar'->>'scheduledFor' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
  GROUP BY ev.event_id HAVING count(DISTINCT s.fields->'calendar')=1
)
UPDATE application_events e SET calendar_uid_key=c.facts->>'uidKey',
  calendar_sequence=(c.facts->>'sequence')::bigint,calendar_method=c.facts->>'method',
  calendar_status=c.facts->>'status',calendar_organizer_domain=c.facts->>'organizerDomain',
  scheduled_for=(c.facts->>'scheduledFor')::timestamptz
FROM calendars c WHERE e.id=c.event_id;
CREATE INDEX idx_events_calendar_revision ON application_events(user_id,calendar_uid_key,calendar_sequence DESC)
  WHERE calendar_uid_key IS NOT NULL AND review_state='ACCEPTED';
COMMIT;
