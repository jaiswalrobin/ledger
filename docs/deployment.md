# First browser version: Vercel + Neon

Use **Vercel** for this Next.js app and **Neon PostgreSQL** for persistence. The first
preview can run the isolated synthetic demo without Google credentials. Cloudflare
Workers would require an adapter and a different database-connection path; it adds
work without improving this first version. A local build or Git push does not
deploy anything; the first production deployment (synthetic demo mode, no Google
credentials) was made separately on 2026-10-13 and is recorded in
[Production deployment record](#production-deployment-record) below.

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


## Production deployment record

First production deployment of commit `610bbf4`, made on 2026-10-13 with the Vercel CLI
from a clean checkout of the pushed branch. It runs the **synthetic demo only**: Google
login and Gmail are not configured, so `googleReady` is `false` and no mailbox can be
connected. This record contains no secrets or account identifiers.

| Item | Value |
| --- | --- |
| Public origin (`APP_URL`) | `https://ledger.jaiswalrobin.com` |
| Hosting | Vercel project `ledger`, Hobby plan, Node 24, region `iad1`, Next.js preset |
| Database | Neon free plan, resource `ledger-db`, AWS `us-east-1`, created through the Vercel Marketplace |
| Migrations | All 6 applied with `npm run migrate` using the **unpooled** connection string; a re-run applies 0 |
| DNS | Only the `ledger` subdomain was added; the zone's wildcard already pointed at Vercel and no other record was changed |
| TLS | Wildcard Let's Encrypt certificate managed by Vercel; HSTS enabled |

Production environment variables that are set (names only):

- `APP_URL`, `DEMO_MODE=true`, `CRON_SECRET` (stored as a hidden secret and not readable back)
- `DATABASE_URL` and the other connection variables injected by the Neon integration

Not set yet, deliberately: `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`. Setting all of them is what switches Google login on.

### Checked against the live origin

- Signed-out access to `/api/dashboard` and `/api/openings/...` returns 401.
- `/api/cron/sync` returns 401 with no or a wrong bearer token; a Vercel-triggered run with the
  real secret returned 200 in the runtime logs.
- Cross-origin protection: a write with the configured origin succeeds, while a write with the
  previous `*.vercel.app` origin, a foreign origin, or no `Origin` header returns 403.
- Session cookie is `Secure; HttpOnly; SameSite=Lax`; a logout invalidates the session.
- The demo workspace loads in a real browser under the nonce-based CSP, and uploading the
  sample `.eml` is applied while a non-`.eml` file is refused with 400.

### Operating notes

- **`APP_URL` is also the CSRF allow-list.** Every write must carry an `Origin` equal to it.
  After changing it, redeploy: environment changes only apply to new deployments. The
  `ledger-*.vercel.app` alias still serves pages but rejects writes by design.
- **Redeploy:** from a checkout linked to the project (`vercel link`), run `vercel deploy --prod`.
- **Git integration is connected,** so pushes build on Vercel and a push to `main` targets
  production. Merge the pull request before relying on that, because `main` has no app until then.
- **Preview and production currently share one Neon database.** Previews have no `APP_URL`,
  `DEMO_MODE` or `CRON_SECRET`, so they are largely inert, but give previews their own Neon
  branch before using them for real work.
- **Scheduler:** `vercel.json` runs the cron once a day (Hobby limit). The 15-minute GitHub
  Actions workflow needs the `LEDGER_SYNC_URL` and `LEDGER_CRON_SECRET` repository secrets and
  only runs from the default branch. `CRON_SECRET` cannot be read back from Vercel, so rotate it
  in both places at once.
- **Google redirect URIs depend on the origin.** Register
  `https://ledger.jaiswalrobin.com/api/oauth/callback/login` and `.../gmail`.
- **Database TLS:** the `pg` driver currently treats `sslmode=require` as `verify-full` and
  warns that `pg` v9 will weaken that. Keep `pg` on v8, or set `sslmode=verify-full` explicitly,
  before upgrading.

## CI/CD, gating and rollback

### What runs

The `Ledger checks` workflow runs on every pull request and on every push to `main`. It has no
path filter, because a required check that is skipped for some files would block those pull
requests indefinitely.

| Job | What it proves | Required to merge |
| --- | --- | --- |
| `domain` | Type-check, the full test suite (embedded PostgreSQL), synthetic demo | Yes |
| `browser` | Migrations on a real PostgreSQL 17, the concurrency tests, a production build, and Playwright against the running server | Yes |
| `audit` | `npm audit` at high severity | No, on purpose: a new advisory must not block a merge that did not cause it |

CI uses **Node 24**, the major version the Vercel project runs. Actions are pinned to full commit
SHAs, and Dependabot proposes weekly updates for npm packages and for the pinned actions. `pg` major
upgrades are excluded from automation (see the TLS note above).

### What gates production

`main` is protected by a ruleset: changes arrive only through a pull request whose `domain` and
`browser` checks pass, and force-pushes and deletion are blocked. Because Vercel's Git integration
deploys `main` to production, **the merge gate is the production gate.** Vercel itself does not wait
for GitHub checks, so do not push to `main` any other way.

### Database migrations are still manual

Migrations are **not** part of the build or the deploy. Code and schema therefore change at
different moments, so every migration must be additive and backward-compatible with the code that is
currently live (add a column or table first; remove or rename only in a later release).

1. Merge the migration file together with code that works both before and after it is applied.
2. Apply it: `npm run migrate` with `DATABASE_URL` set to the Neon **unpooled** connection string,
   from a trusted shell (`vercel env pull` provides it; delete the file afterwards).
3. Deploy code that depends on the new schema only after step 2 has succeeded.

Migrations are checksummed and serialised by the runner, so re-running is safe.

### Rolling back

Vercel keeps every previous deployment, so reverting application code takes seconds and does not
touch the database:

```bash
npx vercel ls ledger --status READY      # find the last good production deployment
npx vercel promote <deployment-url>      # or: npx vercel rollback
```

Rolling back code does **not** undo migrations. This is why migrations must stay backward-compatible:
the previous release has to keep working against the newer schema.

### Not built yet

- Automated deploys from CI (apply migrations, deploy, smoke-test, roll back on failure). This needs
  a `VERCEL_TOKEN` stored as a GitHub secret and Vercel's own Git auto-deploy turned off.
- A post-deploy smoke test; the checks recorded above were run by hand.
- A separate database for preview deployments.
- The scheduler is silent when its secrets are missing (it exits successfully after printing a
  notice). GitHub also disables scheduled workflows in public repositories after 60 days without
  repository activity, so re-enable it if the schedule stops.
