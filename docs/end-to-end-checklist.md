# Getting Ledger working end to end

The synthetic demo is recorded as deployed at **https://ledger.jaiswalrobin.com** on
Vercel with Neon. Google login/Gmail are not configured in that deployment record.
The fixes on PR #1 do not become production code merely by being pushed: release
them through the protected `main` pipeline after its exact commit passes CI.

## Required for the updated demo release

1. **Production deployment credential.** Verify/set `VERCEL_TOKEN` in the GitHub
   Actions environment named `production`, with an expiry and access to the Vercel
   `ledger` project. Verify its variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and
   `PRODUCTION_URL=https://ledger.jaiswalrobin.com`. The preceding deployment record
   identified the token as still missing; external secret settings have not been
   verified from this cloud environment. Enter credentials in secure provider
   settings, never a chat, source file, or `NEXT_PUBLIC_*` variable.
2. **Database and release gate.** Confirm Vercel production has `DATABASE_URL` and
   `DATABASE_URL_UNPOOLED`, plus the existing `APP_URL`, `DEMO_MODE` and `CRON_SECRET`.
   Confirm the `domain` and `browser` checks are required by the `main` ruleset and
   that the GitHub `production` environment permits `main` only.
3. **Release PR #1 after its new checks pass.** The pipeline stages the build,
   applies pending migrations (there are now seven), promotes and smoke-tests it.
   It requires a verified previous deployment before changing anything. Failures
   after promotion is attempted trigger rollback, domain verification and a fresh
   smoke test; failed recovery is reported as unverified. A green PR run skips
   deployment and does not prove that these production credentials work.
4. **Verify production.** Open the public origin, explore the demo, import the
   sample, create an attempt from a review under an existing opening, correct its
   submission date, reload, and delete that test workspace. Run the Actions
   rollback drill with `simulate_failure` and verify the summary says recovery was
   verified and that the previous healthy site is restored. This is a controlled
   release/rollback operation; do it when the brief promotion window is acceptable.

The changes here have local fault-injection coverage. The updated pipeline and
new migration have not been exercised against production in this cloud session;
no production release or real inbox access was performed here. This environment's
network policy blocks the live domain and GitHub API, so external settings and live
availability could not be independently checked.

## Required for a private Gmail pilot

1. **Production-only hosting.** Automatic Git previews are disabled for all branches.
   Remove already-created Preview deployments and their Preview database bindings
   before enabling Google. The production operations workflow inventories/deletes
   previews using the existing production credential; see [google-setup.md](google-setup.md).
   A Vercel config change alone does not remove old deployments or their credentials.
2. **Create a Google web OAuth client.** Enable Gmail API and set the consent app
   to Testing. Add the dedicated test Google accounts as permitted test users.
   Register these exact production redirects:
   - `https://ledger.jaiswalrobin.com/api/oauth/callback/login`
   - `https://ledger.jaiswalrobin.com/api/oauth/callback/gmail`
3. **Set the secure production configuration.** Supply `ALLOWED_EMAILS` (the Google
   login addresses permitted into Ledger), `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET` (random base64 material of at least 32
   bytes), and `TOKEN_ENCRYPTION_KEY` (a separate random base64 key of exactly 32
   bytes). Keep a separate `CRON_SECRET` of at least 24 random characters. Redeploy
   after changing Vercel environment variables. Do not rotate the token-encryption
   key blindly: existing encrypted grants must be migrated or reconnected.
4. **Log in, then connect dedicated Gmail separately.** Login only requests identity
   scopes; the explicit mailbox connection requests Gmail read-only. Complete the
   dedicated-account confirmation, consent, and **Sync now**. Use synthetic
   recruiting messages in an authorized dedicated test inbox for the pilot.
5. **Enable ongoing polling.** Set GitHub repository Actions secrets
   `LEDGER_SYNC_URL=https://ledger.jaiswalrobin.com/api/cron/sync` and
   `LEDGER_CRON_SECRET` equal to Vercel's `CRON_SECRET`. The 15-minute workflow must
   exist on `main`. Verify a run succeeds and mailbox freshness advances. The
   once-daily Vercel Hobby cron is a fallback; by itself it does not provide
   15-minute freshness. If the existing hidden Vercel secret is unavailable,
   rotate both scheduler bindings together and redeploy. Schedules are best effort;
   keep **Sync now**, failure counts and explicit retries available.
6. **Validate the real provider flow.** Confirm two mailbox connections maintain
   independent attempts/cursors; verify read-only scopes; ingest a confirmation,
   assessment/interview and terminal update; inspect evidence and reviews; reject
   and restore an event; disconnect during pending work, reconnect, and verify it
   completes; revoke access at Google and verify degraded coverage; log out and
   confirm the session stops working; disconnect all active mailboxes and delete
   the pilot workspace. Unknown/unauthenticated terminal updates deliberately
   require owner review. Existing tests use provider fakes and do not replace this
   live OAuth/inbox validation.

Google Testing-mode grants can expire after seven days. Reconnect expired grants
and verify the app surfaces the failure. Broader/public Gmail use requires the
appropriate consent/verification process for the restricted scope and intended
user population; validate those requirements for the actual launch.

## Before a public service or valuable real data

Set explicit backup/restore and backup-expiry policies, least-privilege runtime and
migration database roles, key rotation/recovery, and failure alerting. The UI/API
and Gmail token access still share a runtime; code-level owner checks and vault
boundaries are tested, while production RLS and separate connector/key access
remain hardening work. Expand extraction ground-truth evaluation to the actual
providers and languages you will support. The prototype intentionally leaves
uncertain interpretations in review and does not claim perfect classification.

## Fixed in this remediation

All nine reviewed defects are addressed: MIME-alternative screening/conflicts,
malformed-link rejection, reconnect requeue, future-date review and audited date
repair, existing-opening review creation in UI and API, bounded revocation, a
populated-schema upgrade preserving IDs and deployed checksums, recovery after
promotion/verification failure, and refusing releases with an unknown rollback
target. Node 24 and the Node-24-native action pins now match production. Production
variables are parsed as dotenv data; shell syntax inside a value is never executed.

See [deployment.md](deployment.md) for operations and
[security-findings.md](security-findings.md) for the audit record.
