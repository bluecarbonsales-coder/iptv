#!/usr/bin/env bash
# Validate and rebuild/deploy the current IPTV Web checkout/package on this server.
# Run as the trusted local agent user with write access to this directory and Docker access:
#   bash tools/local-agent-deploy.sh
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

for bin in node docker curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Required command not found: $bin" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required" >&2; exit 1; }
[[ -f docker-compose.yml ]] || { echo "Expected docker-compose.yml in $APP_DIR" >&2; exit 1; }
[[ -f Dockerfile ]] || { echo "Expected Dockerfile in $APP_DIR" >&2; exit 1; }
[[ -f .env ]] || {
  echo "Refusing deployment: $APP_DIR/.env is missing. Preserve/configure deployment secrets first; do not replace them with blank defaults." >&2
  exit 1
}

echo "=== Validate server and browser JavaScript ==="
node --check server.js
for file in lib/*.js public/*.js public/js/*.js tools/*.js; do
  [[ -f "$file" ]] && node --check "$file"
done

if compgen -G 'test/*.test.js' >/dev/null; then
  echo "=== Run regression tests ==="
  node --test test/*.test.js
fi

echo "=== Validate Compose configuration ==="
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
echo "Deployment healthy. Existing Compose volumes (including iptv-data) were preserved."
