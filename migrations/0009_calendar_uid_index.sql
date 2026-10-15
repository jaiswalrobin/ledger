BEGIN;
-- Calendar revisions are linked by the hashed UID stored in extracted_signals.fields. Without an
-- index every calendar message scans all of the owner's signals.
CREATE INDEX idx_signals_calendar_uid ON extracted_signals (user_id, ((fields->'calendar'->>'uidKey')))
  WHERE fields ? 'calendar';
COMMIT;
