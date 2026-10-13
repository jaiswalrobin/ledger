BEGIN;
CREATE TABLE demo_workspaces (
  user_id uuid PRIMARY KEY REFERENCES ledger_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
COMMIT;
