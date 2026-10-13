# First browser version: Vercel + Neon

Use **Vercel** for this Next.js app and **Neon PostgreSQL** for persistence. The first
preview can run the isolated synthetic demo without Google credentials. Cloudflare
Workers would require an adapter and a different database-connection path; it adds
work without improving this first version. No deployment has been performed by
the local build or Git push.

## Browser preview

1. Import `jaiswalrobin/ledger` into a Vercel project and select the
   `feat/first-browser-version` branch for the preview. Framework: Next.js;
   install: `npm ci`; build: `npm run build`.
2. Connect a Neon database through the Vercel integration. Keep its connection
   string in Vercel's secure `DATABASE_URL` setting; use the provider's verified TLS
   connection settings. Give the preview its own database/branch, separate from
   production. There is no in-memory or filesystem persistence fallback.
3. Set `APP_URL` to the actual stable HTTPS origin, without a path or query.
   Set `DEMO_MODE=true`. Do not put credentials in `NEXT_PUBLIC_*` variables.
4. Apply the SQL migrations against that database using `npm run migrate` from a
   trusted, authorized environment with the corresponding `DATABASE_URL` binding.
   Use a migration-capable database role there, and an appropriately restricted
   runtime role for the app. Migration files are checksum-checked and serialized
   with a transaction-scoped PostgreSQL lock. Older filename-only records acquire
   a checksum baseline on their first upgrade; review those files before upgrading.
5. Deploy the preview, open it, and choose **Explore the demo**. Each browser gets
   an isolated PostgreSQL-backed workspace: four openings, five attempts, and one
   ambiguous update. Import the downloadable sample, open an attempt timeline,
   reject/restore an event, review an update, and reload to confirm persistence.

An actual preview URL is available only after Vercel authenticates the deployment
and that database is configured and migrated. A successful local build does not
establish a deployed or remotely reachable instance.

## Google login and dedicated Gmail

Keep the Google app in Testing mode and explicitly add the owner's dedicated test
accounts. In Vercel's secure settings configure:

| Variable               | Requirement                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- |
| `ALLOWED_EMAILS`       | Comma-separated verified Google login addresses allowed into the private app |
| `GOOGLE_CLIENT_ID`     | Google web OAuth client ID                                                   |
| `GOOGLE_CLIENT_SECRET` | That client's secret                                                         |
| `AUTH_SECRET`          | Base64-encoded cryptographically random material, at least 32 bytes          |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded cryptographically random material, exactly 32 bytes           |
| `CRON_SECRET`          | A separate cryptographically random credential, at least 24 characters       |

Register these exact Google authorized redirect URIs using the chosen `APP_URL`:

```text
https://YOUR-STABLE-ORIGIN/api/oauth/callback/login
https://YOUR-STABLE-ORIGIN/api/oauth/callback/gmail
```

Login requests `openid email`; a Gmail connection is a separate, explicit grant
requesting `openid email https://www.googleapis.com/auth/gmail.readonly`. The grant
validator rejects send/modify permissions. Tokens are encrypted with AES-256-GCM
and mailbox-bound AAD; the callback validates state, nonce, audience, authorized
party, expiry, and verified email. ID tokens are accepted only from Google's pinned
TLS token endpoint, never from client-supplied JSON. Sessions are random opaque
tokens, stored as hashes and invalidated on logout; removing an email from the
allowlist denies existing sessions too.

From **Connections**, confirm that you will use a dedicated job-search account,
connect it, then choose **Sync now**. Each account has independent leases, cursors,
durable tasks, retries, coverage, and failure counts. Failed work can be retried
explicitly. Disconnect stops access locally before a best-effort provider revoke;
if Google cannot confirm revocation, remove the app's access in Google account settings.

The live Google flow has not been verified with real credentials or inboxes in this
environment. The OAuth helpers, scope rules, session binding, and Gmail pipeline
are tested with synthetic responses. Read `privacy-security.md` and
`security-findings.md` before granting real inbox access. This prototype's Gmail
credential boundary is enforced by code/tests; API/UI and connector still share a
runtime. Production RLS, managed key rotation, broader provider evaluation,
backup retention, and any required Google verification/security assessment remain
launch work. No public-production readiness is claimed.

## Scheduling and retention

`vercel.json` supplies a once-daily authenticated cron backup on Vercel Hobby.
For roughly 15-minute polling, after the workflow is on the repository's default
branch, configure these GitHub Actions secrets:

- `LEDGER_SYNC_URL`: `https://YOUR-STABLE-ORIGIN/api/cron/sync`
- `LEDGER_CRON_SECRET`: the same secret configured as `CRON_SECRET` on Vercel

The workflow fails closed on invalid configuration and uses no request/response
tracing or credential-bearing command arguments. Schedules are best effort;
**Sync now** remains available. A preview deployment is not proof that cron has
been activated. Vercel Pro can replace the separate 15-minute workflow with an
appropriate Vercel schedule if desired.

Demo workspaces expire after seven days and are pruned by the authenticated cron
and subsequent demo creation. Google-account history is retained until explicit
workspace deletion. Disconnect/revoke every active mailbox before deleting the
workspace. Full production backup-expiry and retention policies remain to be set.

## Local validation

Use an isolated PostgreSQL 15+ database. The development container below is for
synthetic data only and is bound to loopback with trust authentication:

```bash
npm ci
bash scripts/dev-db.sh
export DATABASE_URL=postgresql://ledger@127.0.0.1:5432/ledger_browser
export APP_URL=http://127.0.0.1:3000
export DEMO_MODE=true
npm run migrate
npm test
npm run test:postgres
npm run typecheck
npm run build
npm run start
```

If a development database/container already exists, reuse it after checking its
configuration; do not remove or reset user data to clear a port conflict. The
cloud task is already isolated; use its existing checkout without creating a worktree.
In another terminal run `npm run test:browser`. Browser tests use a packaged
Chromium binary; web security remains enabled. They verify actual rendered pages,
PostgreSQL persistence, uploads, reviews, mobile navigation, owner isolation, CSRF,
logout revocation, and deletion. Live processes and Docker container data should
not be assumed to survive cloud snapshots.
