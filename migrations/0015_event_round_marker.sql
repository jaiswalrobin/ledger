BEGIN;
-- Set when the email behind an assessment or interview event said it follows an earlier round
-- ("positive feedback from your previous interview"). Rounds themselves are projected from
-- accepted events (src/domain/rounds.ts); this records the one fact the projection cannot infer.
ALTER TABLE application_events ADD COLUMN starts_round boolean NOT NULL DEFAULT false;
-- The newest email attached to the event after it was recorded (a reminder, a repeat
-- confirmation). Keeps the attempt's last activity current without a duplicate event.
ALTER TABLE application_events ADD COLUMN latest_evidence_at timestamptz;
COMMIT;
