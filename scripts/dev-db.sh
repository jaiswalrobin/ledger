#!/usr/bin/env bash
set -euo pipefail
local_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
local_docker info --format '{{.ServerVersion}}' >/dev/null
database_image='postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3'
database_container='ledger-browser-postgres'
if local_docker container inspect "$database_container" >/dev/null 2>&1; then
  :
elif local_docker container inspect ledger-postgres >/dev/null 2>&1; then
  database_container='ledger-postgres'
else
  local_docker run -d --name "$database_container" \
    -e POSTGRES_USER=ledger -e POSTGRES_DB=ledger_browser -e POSTGRES_HOST_AUTH_METHOD=trust \
    -p 127.0.0.1:5432:5432 "$database_image" >/dev/null
fi
# Preserve existing data and refuse unrelated/externally exposed containers.
test "$(local_docker inspect --format '{{.Image}}' "$database_container")" = "$(local_docker image inspect --format '{{.Id}}' "$database_image")"
test "$(local_docker inspect --format '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostIp}}' "$database_container")" = '127.0.0.1'
local_docker start "$database_container" >/dev/null
for attempt in $(seq 1 30); do
  if local_docker exec "$database_container" pg_isready -U ledger -d postgres >/dev/null 2>&1; then
    if [[ "$(local_docker exec "$database_container" psql -U ledger -d postgres -Atc "SELECT datname FROM pg_database WHERE datname='ledger_browser'")" != 'ledger_browser' ]]; then
      local_docker exec "$database_container" psql -U ledger -d postgres -c 'CREATE DATABASE ledger_browser' >/dev/null
    fi
    echo 'Local synthetic-development PostgreSQL is ready.'
    exit 0
  fi
  sleep 1
done
echo 'Database readiness failed. Inspect the existing container; do not reset user data.' >&2
exit 1
