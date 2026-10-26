# First browser version: Vercel + Neon

Use **Vercel** for this Next.js app and **Neon PostgreSQL** for persistence. The first
preview can run the isolated synthetic demo without Google credentials. Cloudflare
Workers would require an adapter and a different database-connection path; it adds
work without improving this first version. A local build or Git push does not
deploy anything; the first production deployment (synthetic demo mode, no Google
credentials) was made separately on 2026-10-13 and is recorded in
[Production deployment record](#production-deployment-record) below.

## Production demo

1. Use the existing Vercel `ledger` project for `jaiswalrobin/ledger`, with `main`
   as its production branch. Framework: Next.js; install: `npm ci`; build:
   `npm run build`. Automatic Git deployments are disabled on all branches;
   the protected GitHub CI/CD workflow stages and promotes production releases.
2. Connect a Neon database through the Vercel integration. Keep its connection
   string in Vercel's secure `DATABASE_URL` setting; use the provider's verified TLS
   connection settings. Keep the database binding in Production only and remove
   older Preview deployments/bindings with the operations guide. There is no
   in-memory or filesystem persistence fallback.
3. Set `APP_URL` to the actual stable HTTPS origin, without a path or query.
   Set `DEMO_MODE=true`. Do not put credentials in `NEXT_PUBLIC_*` variables.
4. Apply the SQL migrations against that database using `npm run migrate` from a
   trusted, authorized environment with the corresponding `DATABASE_URL` binding.
   Use a migration-capable database role there, and an appropriately restricted
   runtime role for the app. Migration files are checksum-checked and serialized
   with a transaction-scoped PostgreSQL lock. The exact pending legacy 0002 migration
   has a runner adapter that backfills normalized company keys before NOT NULL/uniqueness.
   Colliding legacy names keep every company ID, domain, and opening through distinct
   reserved keys. Already applied files and their checksums are unchanged. Older filename-only records acquire
   a checksum baseline on their first upgrade; review those files before upgrading.
5. Release through the production pipeline, open the public origin, and choose **Explore the demo**. Each browser gets
   an isolated PostgreSQL-backed workspace: four openings, five attempts, and one
   ambiguous update. Import the downloadable sample, open an attempt timeline,
   reject/restore an event, review an update, and reload to confirm persistence.

The production origin becomes usable after Vercel authenticates the deployment
and its database is configured and migrated. A successful local build does not
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

### What a scheduled run reports

`/api/cron/sync` answers with a counts-only report (no addresses, ids or message data):
how many mailboxes ran and how many ended `OK`, `PARTIAL`, `BUSY`, `DEGRADED`, `FAILED` or
`SKIPPED`, whether Gmail is configured, and whether expired-demo cleanup failed. Cleanup and each
mailbox are isolated: a cleanup error or one mailbox crashing never stops the others.

The workflow prints that report, adds it to the run summary, and decides the run's colour from it:

| Situation | Workflow result |
| --- | --- |
| Secrets missing on GitHub | Green with a *Scheduler not configured* warning |
| URL not `https://…/api/cron/sync`, or secret under 24 characters | Red, naming the bad secret |
| HTTP 401 | Red: *Secret mismatch* between `LEDGER_CRON_SECRET` and Vercel `CRON_SECRET` |
| HTTP 503 | Red: `CRON_SECRET` missing on the deployment, or the database is down |
| Endpoint unreachable, timeout, 429 or 5xx | Retried twice, 20 s apart; red if still failing |
| Google credentials not set on the deployment | Green with a *Gmail not configured* warning |
| A mailbox `DEGRADED` (revoked grant, failed messages) | Green with a *needs attention* warning; the owner fixes it under Connections |
| A mailbox `FAILED` | Red; check the Vercel function logs |

Before this report existed the endpoint returned 200 even when every mailbox failed, so a green run
did not prove anything was synced.

### Getting dependable 15-minute polling

GitHub runs scheduled workflows on a best-effort basis: runs are delayed, often by hours, and
dropped under load, and GitHub disables schedules in repositories with no activity for 60 days. The
workflow uses odd minutes (`7,22,37,52`) to avoid the busiest moments, but that only helps a little.
Ledger marks monitoring as incomplete when a mailbox has not synced for 45 minutes, so long gaps
show up in the UI as "Monitoring incomplete" rather than being hidden.

For dependable polling, call the endpoint from a scheduler with a real timing guarantee and keep the
GitHub workflow as a backup. Any of these works, since a run is idempotent and mailbox leases
prevent overlapping work:

- Vercel Pro: change the `vercel.json` cron to `*/15 * * * *` (Vercel adds the bearer header).
- An external HTTPS cron service: `POST https://YOUR-STABLE-ORIGIN/api/cron/sync` every 15 minutes
  with the header `Authorization: Bearer <CRON_SECRET>` and a timeout of at least 300 s.

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

| Item                      | Value                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Public origin (`APP_URL`) | `https://ledger.jaiswalrobin.com`                                                                                    |
| Hosting                   | Vercel project `ledger`, Hobby plan, Node 24, region `iad1`, Next.js preset                                          |
| Database                  | Neon free plan, resource `ledger-db`, AWS `us-east-1`, created through the Vercel Marketplace                        |
| Migrations                | All 6 applied with `npm run migrate` using the **unpooled** connection string; a re-run applies 0                    |
| DNS                       | Only the `ledger` subdomain was added; the zone's wildcard already pointed at Vercel and no other record was changed |
| TLS                       | Wildcard Let's Encrypt certificate managed by Vercel; HSTS enabled                                                   |

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
- **Redeploy:** run the CI/CD workflow on `main`; use explicit staged deployment and promotion for the documented manual recovery path.
- **Production is deployed by the pipeline, not by Vercel's Git integration.** `vercel.json` turns
  Git-triggered deployments off for every branch; automatic pull-request previews are disabled too. See
  [CI/CD](#cicd-gating-and-rollback).
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

One workflow, `Ledger CI/CD` (`.github/workflows/domain-ci.yml`), runs the checks and the deploy.
It has no path filter, because a required check that is skipped for some files would block those
pull requests indefinitely.

| Job       | Runs on                                                              | What it proves or does                                                                                                                   | Required to merge                                                           |
| --------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `domain`  | pull request, `main`                                                 | Type-check, the full test suite (embedded PostgreSQL), synthetic demo                                                                    | Yes                                                                         |
| `browser` | pull request, `main`                                                 | Migrations on PostgreSQL 17, the concurrency tests, a production build, Playwright, and the deploy smoke test against the running server | Yes                                                                         |
| `audit`   | pull request, `main`                                                 | `npm audit` at high severity                                                                                                             | No, on purpose: a new advisory must not block a merge that did not cause it |
| `deploy`  | `main` only, after `domain` and `browser` pass for that exact commit | Ships it to production (below)                                                                                                           | n/a                                                                         |

CI uses **Node 24**, the major version the Vercel project runs. Actions are pinned to full commit
SHAs; Dependabot proposes weekly updates for npm packages and for those pins (`pg` major upgrades
are excluded, see the TLS note above).

### What the deploy job does, in order

1. **Guard.** Refuses to run if its configuration is missing or the previous production deployment cannot be inspected and validated, and skips quietly if a newer commit has
   already landed on `main` (the run for that commit deploys it), so an older run can never overwrite
   a newer deploy.
2. **Build a staged production deployment** with `vercel deploy --prod --skip-domain`. It takes no
   traffic, so a broken build never reaches users and never touches the database.
3. **Apply migrations** to the production database over the unpooled connection. A failed migration
   stops the job before anything is promoted. The credentials are fetched only now and deleted
   straight after.
4. **Promote** the staged deployment to the production domain, then confirm the domain really serves it.
5. **Smoke-test the live site** (`scripts/smoke.ts`): security headers, signed-out requests refused,
   the cron endpoint failing closed, cross-origin writes refused, and a demo workspace round trip
   through the database.
6. **If promotion, domain verification, or the smoke test fails:** attempt rollback to the recorded
   previous deployment, verify the domain and re-run smoke. The run fails even after successful
   recovery. A failed rollback is explicitly reported as unverified recovery. A production-domain
   recheck before promotion also stops a release if someone deployed manually while it was staging.

The ordered release and recovery live in `scripts/deploy-production.sh`. Its regression harness
fault-injects lookup, build, migration, promotion-response, verification, smoke and rollback failures.
Pulled variables are parsed by `scripts/migrate-production.ts` as dotenv data and deleted; they are
never sourced as shell code. Only the unpooled database binding is passed to the migration process.

The run summary lists the commit, the staged and previous deployments, the migrations applied, the
smoke result and whether a rollback happened.

### What gates production

- **`main` is protected by a ruleset:** changes arrive only through a pull request whose `domain`
  and `browser` checks pass, and force-pushes and deletion are blocked.
- **Vercel's own Git deploy of `main` is switched off** (`git.deploymentEnabled` in `vercel.json`),
  so the pipeline is the only automated way to production.
- **Credentials live in the GitHub environment `production`,** which accepts deployments from `main`
  only. Pull requests and forks never see them.

### One-time setup that lives outside git

The environment `production` and its variables (`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
`PRODUCTION_URL`) already exist. The one remaining credential is a Vercel token:

1. Vercel dashboard, Account Settings, Tokens: create one named `ledger-github-deploy`, scoped to the
   account, with an expiry.
2. Store it without echoing it:
   `gh secret set VERCEL_TOKEN --env production --repo jaiswalrobin/ledger`

Set the secret **before** merging the pull request that introduces the pipeline. Without it the deploy
job fails at "Require deployment configuration" with a message naming what is missing; production then
simply stays on the current deployment. Tokens expire, so put the expiry date in a calendar; rotating
is the same command with a new token.

### Everyday operations

- **Ship a change:** merge a green pull request. Nothing else.
- **Redeploy without a code change** (for example after editing an environment variable in Vercel):
  Actions, `Ledger CI/CD`, Run workflow, branch `main`.
- **Prove the rollback still works:** run the workflow with `simulate_failure` ticked. Expect a red run,
  "Recovery: verified" in the summary, and a healthy site. Do this after changing the pipeline.
- **Roll back by hand:**
  ```bash
  npx vercel ls ledger --status READY        # find the last good production deployment
  npx vercel rollback <deployment-url> --yes
  ```
- **Run the smoke test yourself:** `BASE_URL=https://ledger.jaiswalrobin.com npm run smoke`
- **Deploy from your machine** (Actions unavailable): `scripts/deploy-production.sh` is the script the
  deploy job runs, so it stages, migrates, promotes, smoke-tests and rolls back on failure. From a clean
  checkout of a commit that is already on `main`, after `npm ci`:
  ```bash
  export VERCEL_TOKEN=...   # a Vercel token for the account; never commit it or echo it
  export VERCEL_ORG_ID=... VERCEL_PROJECT_ID=... PRODUCTION_URL=https://ledger.jaiswalrobin.com
  export GITHUB_SHA="$(git rev-parse HEAD)"
  bash scripts/deploy-production.sh
  ```
  The two IDs and the URL are the `production` environment's variables: `gh variable list --env production`.
  Prefer this to the hand steps below, which have no smoke test or automatic rollback.
- **Break glass** (Actions unavailable): deploy with `npx vercel deploy --prod --skip-domain`, apply
  migrations with `npm run migrate` (unpooled `DATABASE_URL`), then `npx vercel promote <url>`. The
  ruleset can be disabled under repository Settings, Rules, if a fix must bypass the checks; re-enable
  it afterwards.

### Migrations: the rule that keeps rollback safe

Migrations run **before** the new code is promoted, and a rollback restores old code against the
**new** schema. So every migration must work with both the code that is live now and the code about to
go live: add columns and tables first; remove or rename only in a later release, after nothing uses them.

### What this pipeline does not do

- **It does not smoke-test before promoting.** The staged URL sits behind Vercel's login, so the check
  runs on the live domain right after promotion. A bad deployment can therefore serve users for the
  seconds it takes to detect and roll back. Testing the staged URL first needs a protection-bypass
  secret; add it if that window matters.
- **Rollback depth is one deployment.** The Hobby plan can only roll back to the previous production
  deployment, which is the only case the pipeline needs.
- **The smoke test's database check needs demo mode.** Once demo mode is turned off, that check is
  skipped and reported as skipped; add a health endpoint then.
- **Runtime version:** `engines.node` is pinned to `24.x`, matching CI and Vercel. Update them together deliberately.
- **Preview deployments share the production database,** and there is no alerting beyond GitHub's
  failure emails.
- **The 15-minute Gmail scheduler is separate** from deploys. It is silent when its secrets are missing,
  and GitHub disables scheduled workflows in public repositories after 60 days without activity.

## End-to-end completion

See the [end-to-end checklist](end-to-end-checklist.md) for the exact secure settings,
release/migration gate, separate preview database, real Google/Gmail validation, scheduler
activation, and remaining public-launch hardening. The original six-migration production
record above is historical; this remediation adds `0007_submission_date_corrections.sql`.
Pushing this branch does not apply that migration or update the live deployment.

Google/Gmail setup and removal of older previews are documented in [google-setup.md](google-setup.md). New preview deployments are disabled; historical shared-database preview notes above describe the preceding deployment state, not a completed cleanup.

## Credential diagnostics

If production inventory succeeds but the CLI reports `User not found`, avoid
assuming that the token owner is wrong. Inventory uses an explicit API team selector;
the release CLI now passes `--scope "$VERCEL_ORG_ID"` on every operation, including
inspect and rollback. Retest the scoped release before replacing credentials.
If it still fails, distinguish the token's user-profile access from project access,
and verify the production environment secret (which overrides a repository secret).
Never share the token value in logs or chat.
