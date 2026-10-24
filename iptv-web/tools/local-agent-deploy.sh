#!/usr/bin/env bash
# Validate and deploy an IPTV Web source checkout/package on this server.
# From a writable repository checkout:
#   IPTV_DEPLOY_DIR=/path/to/active/iptv-web bash iptv-web/tools/local-agent-deploy.sh
# If this script is already inside the active Compose directory, IPTV_DEPLOY_DIR is optional.
set -Eeuo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="${IPTV_DEPLOY_DIR:-$SOURCE_DIR}"
[[ -d "$DEPLOY_DIR" ]] || { echo "Deployment directory does not exist: $DEPLOY_DIR" >&2; exit 1; }
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd)"

for bin in node docker curl tar; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Required command not found: $bin" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required" >&2; exit 1; }
[[ -f "$SOURCE_DIR/Dockerfile" ]] || { echo "Expected Dockerfile in source directory $SOURCE_DIR" >&2; exit 1; }
[[ -f "$SOURCE_DIR/docker-compose.yml" ]] || { echo "Expected docker-compose.yml in source directory $SOURCE_DIR" >&2; exit 1; }
[[ -f "$DEPLOY_DIR/docker-compose.yml" ]] || { echo "Expected active docker-compose.yml in deployment directory $DEPLOY_DIR" >&2; exit 1; }
[[ -f "$DEPLOY_DIR/.env" ]] || {
  echo "Refusing deployment: $DEPLOY_DIR/.env is missing. Preserve/configure deployment secrets first; do not replace them with blank defaults." >&2
  exit 1
}

echo "=== Validate source checkout: $SOURCE_DIR ==="
cd "$SOURCE_DIR"
node --check server.js
for file in lib/*.js public/*.js public/js/*.js tools/*.js; do
  [[ -f "$file" ]] && node --check "$file"
done
if compgen -G 'test/*.test.js' >/dev/null; then
  echo "=== Run regression tests ==="
  node --test test/*.test.js
fi

if [[ "$SOURCE_DIR" != "$DEPLOY_DIR" ]]; then
  echo "=== Sync tested source into active deployment directory (preserving .env) ==="
  ARCHIVE="$(mktemp)"
  trap 'rm -f "$ARCHIVE"' EXIT
  tar --exclude='./.env' --exclude='./.git' -czf "$ARCHIVE" -C "$SOURCE_DIR" .
  tar --no-same-owner --no-same-permissions -xzf "$ARCHIVE" -C "$DEPLOY_DIR"
  rm -f "$ARCHIVE"
  trap - EXIT
fi

echo "=== Validate active Compose configuration ==="
cd "$DEPLOY_DIR"
docker compose config -q

echo "=== Build application image ==="
docker compose build iptv-web

echo "=== Deploy updated application ==="
docker compose up -d iptv-web

echo "=== Wait for application health ==="
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3920/healthz >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != "1" ]]; then
  docker compose ps
  docker compose logs --tail=100 iptv-web
  echo "Deployment did not become healthy. Persistent volumes were not removed." >&2
  exit 1
fi

docker compose ps iptv-web
echo "Deployment healthy. The active .env and existing Compose volumes (including iptv-data) were preserved."
