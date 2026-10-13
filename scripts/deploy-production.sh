#!/usr/bin/env bash
# Production already exists. Bootstrap a first deployment separately; never silently
# replace a failed lookup with an imaginary "first release".
set -euo pipefail
: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
: "${PRODUCTION_URL:?PRODUCTION_URL is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
VERCEL_CLI_VERSION="${VERCEL_CLI_VERSION:-63.1.2}"
# The env IDs link deploy/pull to the project, but inspect also needs an explicit
# scope: otherwise the CLI discovers accounts through its unscoped user/team APIs.
# The token is passed explicitly as well as through the environment so the CLI never
# falls back to a stored login when it resolves the account ("User not found").
cli() { npx --yes "vercel@${VERCEL_CLI_VERSION}" "$@" --token "$VERCEL_TOKEN" --scope "$VERCEL_ORG_ID"; }
work_directory="$(mktemp -d)"
previous_url='' previous_id='' staged_id='' migrations='not run'
promotion_attempted=false recovery='not needed' smoke_outcome='not run'
# Do not leave pulled production credentials behind after a failed step.
finish() {
  local status=$?
  trap - EXIT
  set +e
  rm -f .vercel/.env.production.local
  if (( status != 0 )) && [[ "$promotion_attempted" == true ]]; then
    recovery='failed'
    echo '::warning::Promotion or post-promotion verification failed. Restoring the previous deployment.'
    # Verification is attempted even if the provider command returns an error:
    # an operation may have succeeded remotely before its response was lost.
    cli rollback "$previous_url" --yes > "$work_directory/rollback.json"
    if inspect "$PRODUCTION_URL" "$work_directory/restored.json" &&
       [[ "$(pick id "$work_directory/restored.json")" == "$previous_id" ]] &&
       BASE_URL="$PRODUCTION_URL" SMOKE_SIMULATE_FAILURE=0 npm run smoke; then
      recovery='verified'
      echo "Previous deployment restored and smoke-tested: $previous_id"
    else
      echo '::error::Automatic recovery could not be verified. Check production and restore the recorded previous deployment immediately.'
    fi
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo '### Production deploy'
      echo ''
      echo '| Item | Result |'
      echo '|---|---|'
      echo "| Commit | ${GITHUB_SHA:0:7} |"
      echo "| Staged deployment | ${staged_id:-not created} |"
      echo "| Previous deployment | ${previous_id:-not recorded} |"
      echo "| Migrations | $migrations |"
      echo "| Smoke | $smoke_outcome |"
      echo "| Recovery | $recovery |"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  rm -rf "$work_directory"
  if (( status != 0 )); then echo '::error::Release failed; see the recovery result above.'; fi
  exit "$status"
}
trap finish EXIT
pick() {
  node --input-type=module - "$1" "$2" <<'JS'
import {readFileSync} from 'node:fs';
const parsed=JSON.parse(readFileSync(process.argv[3],'utf8')), data=parsed.deployment??parsed;
const value=data[process.argv[2]];
if(typeof value!=='string'||!value||/[\r\n]/.test(value))throw new Error('INVALID_DEPLOYMENT_METADATA');
if(process.argv[2]==='id'&&!/^dpl_[a-zA-Z0-9]+$/.test(value))throw new Error('INVALID_DEPLOYMENT_ID');
if(process.argv[2]==='url'){
 const url=new URL(value.startsWith('https://')?value:`https://${value}`);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.vercel.app'))throw new Error('INVALID_DEPLOYMENT_URL');
 console.log(url.origin);
}else console.log(value);
JS
}
inspect() { cli inspect "$1" --format json > "$2"; }
node --input-type=module <<'JS'
const u=new URL(process.env.PRODUCTION_URL??'');
if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('PRODUCTION_ORIGIN_REQUIRED');
JS
# Abort before staging or touching the database when the rollback target is unknown.
inspect "$PRODUCTION_URL" "$work_directory/previous.json"
previous_url="$(pick url "$work_directory/previous.json")"
previous_id="$(pick id "$work_directory/previous.json")"
echo "Previous production deployment: $previous_id"
cli deploy --prod --skip-domain --yes --format json \
  -m "githubCommitSha=${GITHUB_SHA}" -m "githubRunId=${GITHUB_RUN_ID:-local}" > "$work_directory/staged.json"
staged_url="$(pick url "$work_directory/staged.json")"
staged_id="$(pick id "$work_directory/staged.json")"
echo "Staged deployment: $staged_id"
# Pulled values are parsed as data, not sourced as a shell script.
cli pull --yes --environment=production
node --experimental-strip-types scripts/migrate-production.ts
migrations='passed'
# Recheck the previous deployment before altering traffic. Abort on an unexpected
# manual release rather than rolling somebody else's deployment back later.
inspect "$PRODUCTION_URL" "$work_directory/current.json"
if [[ "$(pick id "$work_directory/current.json")" != "$previous_id" ]]; then
  echo '::error::Production changed while staging. Release stopped before promotion.'
  exit 1
fi
promotion_attempted=true
cli promote "$staged_url" --yes
inspect "$PRODUCTION_URL" "$work_directory/live.json"
if [[ "$(pick id "$work_directory/live.json")" != "$staged_id" ]]; then
  echo '::error::The production domain is not serving the staged deployment.'
  exit 1
fi
smoke_outcome='failed'
BASE_URL="$PRODUCTION_URL" SMOKE_SIMULATE_FAILURE="${SMOKE_SIMULATE_FAILURE:-0}" npm run smoke
smoke_outcome='passed'
echo 'Production release verified.'
