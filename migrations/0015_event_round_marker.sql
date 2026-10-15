BEGIN;
-- Set when the email behind an assessment or interview event said it follows an earlier round
-- ("positive feedback from your previous interview"). Rounds themselves are projected from
-- accepted events (src/domain/rounds.ts); this records the one fact the projection cannot infer.
ALTER TABLE application_events ADD COLUMN starts_round boolean NOT NULL DEFAULT false;
COMMIT;
