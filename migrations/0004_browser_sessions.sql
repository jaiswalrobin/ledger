BEGIN;
CREATE TABLE browser_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ledger_users(id) ON DELETE CASCADE,
  is_demo boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE browser_rate_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  reset_at timestamptz NOT NULL
);
COMMIT;
