BEGIN;
-- This audit flag is set by the server's Gmail metadata path, never by an uploaded header.
ALTER TABLE source_artifacts ADD COLUMN sender_authenticated boolean NOT NULL DEFAULT false;
COMMIT;
