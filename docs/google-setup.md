# Private Google/Gmail setup with production only

Automatic Vercel Git deployments are disabled for all branches in `vercel.json`.
The protected GitHub pipeline remains the production release path. CI still runs
on pull requests; it does not create a hosted preview. Changing this flag does not
delete older previews or revoke database credentials already issued to them.

## Remove existing previews

After this change is merged onto `main`, open Actions → **Production setup operations**.
Choose `remove-previews` on `main`. A dry run inventories the project's preview
deployments; uncheck `dry_run` to delete them. The operation uses the existing
`production` environment's Vercel token/project variables, validates every deployment,
and refuses production, foreign-project or concurrently promoted deployments.
It shares the production deployment lock. No token values are printed.

Alternatively, delete those Preview deployments in the Vercel `ledger` project's
Deployments tab, and remove Preview targets from its database environment settings.
Keep the production database and deployment. Once the old previews are removed,
rotate the Neon runtime credential if those previews had access to it, update the
secure production connection bindings, and redeploy. Do not rotate the token vault
key as part of this database-credential change.

## Create the Google client

Use a dedicated Google Cloud project named **Ledger**, or select your existing
Ledger project. Enable **Gmail API**. In Google Auth Platform:

1. Branding: set the app name to Ledger and select a support/contact email you control.
2. Audience: choose External and keep publishing status **Testing**. Add the login
   account and each dedicated Gmail test account to **Test users**.
3. Data Access: configure identity scopes and
   `https://www.googleapis.com/auth/gmail.readonly`. Do not request send or modify.
4. Clients: create a **Web application** OAuth client, with these authorized redirects:
   - `https://ledger.jaiswalrobin.com/api/oauth/callback/login`
   - `https://ledger.jaiswalrobin.com/api/oauth/callback/gmail`

Login's allowlist does not connect a mailbox. Sign in with the selected login
address, then explicitly choose a dedicated job-search account in Connections.
That dedicated account also needs to be a Google Testing user; it need not be a
separate Ledger login. Avoid connecting a primary personal inbox.

## Supply credentials securely and provision the app

In GitHub Settings → Environments → `production` → Environment secrets, set:

| Name                   | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | The web OAuth client ID ending in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Its client secret, copied directly from Google                  |
| `ALLOWED_EMAILS`       | The selected Google login address(es), comma separated          |

Keep addresses and secrets in secure settings; do not commit them or paste secrets
into chat. `VERCEL_TOKEN` and the Vercel project/org variables use the existing
production configuration. Google project creation and consent settings require
access to your Google account; this cloud coding session has no Google admin binding.

Run **Production setup operations** on `main` with `configure-google`. This refuses
to proceed while any Preview deployment remains. It creates the five missing Google
configuration variables on Vercel **Production only**, including independent random
32-byte signing and token-encryption keys. Existing hidden credentials and encryption
keys are preserved; they are never displayed or silently rotated. Partial existing
OAuth client settings or keys shared with Preview cause an explicit failure for
manual correction in Vercel settings. If an allowlist already exists, check that it
includes the requested login addresses; this initial-provisioning operation preserves it.

Then run **Ledger CI/CD** on `main` to redeploy. Vercel setting changes do not update
an already running deployment. The app also needs its existing `DATABASE_URL`,
`APP_URL`, and `CRON_SECRET`; the operations job does not alter those.

## Verify the private pilot

Open the production site, sign in, and check that an unlisted Google login is denied.
Connect a dedicated test inbox, choose Sync now, and exercise synthetic confirmations,
interviews and terminal events. Inspect reviews, disconnect/reconnect, revoke access,
and verify the session stops working after logout. Do not declare the Google setup
complete until these live-provider checks pass.

For ongoing polling, set the repository Actions secrets `LEDGER_SYNC_URL` and
`LEDGER_CRON_SECRET` as described in [end-to-end-checklist.md](end-to-end-checklist.md).
The once-daily Vercel cron remains a fallback. Testing-mode Google grants may expire
after seven days; verify that failure and reconnection remain visible.
