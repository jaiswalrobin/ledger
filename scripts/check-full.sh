#!/usr/bin/env bash
# Everything CI runs, locally: `npm run check:full`. Needs a disposable local PostgreSQL in
# DATABASE_URL (scripts/dev-db.sh starts one); migrations and tests write to it.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?Set DATABASE_URL to a disposable local database, e.g. postgresql://ledger@127.0.0.1:5432/ledger_browser}"
case "$DATABASE_URL" in
  *@127.0.0.1[:/]* | *@localhost[:/]*) ;;
  *) echo "REFUSED: DATABASE_URL must point at 127.0.0.1 or localhost; this script migrates and writes test data." >&2; exit 1 ;;
esac
# The same configuration as the CI browser job. CRON_SECRET is a throwaway that protects nothing.
export APP_URL=http://127.0.0.1:3000 DEMO_MODE=true NEXT_TELEMETRY_DISABLED=1
export CRON_SECRET=ci-only-not-a-real-secret-0000000000

# A server left over from an earlier run would answer the browser tests with an old build.
if curl --silent --max-time 2 --output /dev/null http://127.0.0.1:3000/; then
  echo "REFUSED: something is already listening on port 3000. Stop it first." >&2
  exit 1
fi

step() { printf '\n== %s\n' "$1"; }
step "format, types, unit tests, demo"; npm run -s check
step "migrations"; npm run -s migrate
step "PostgreSQL tests"; npm run -s test:postgres
step "production build"; npm run -s build

step "browser tests and smoke"
log=$(mktemp)
# Job control gives the server its own process group (on Linux and macOS), so the cleanup also
# stops next-server, not just npm.
set -m
npm run -s start -- --hostname 127.0.0.1 >"$log" 2>&1 &
server=$!
set +m
trap 'kill -- -"$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl --fail --silent --output /dev/null http://127.0.0.1:3000/api/session && break
  sleep 1
done
npm run -s test:browser || { echo "Server log: $log" >&2; exit 1; }
BASE_URL=http://127.0.0.1:3000 npm run -s smoke
echo; echo "All checks passed."
