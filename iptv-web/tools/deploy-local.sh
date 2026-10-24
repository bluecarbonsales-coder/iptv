#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$WORKSPACE" ]] || { echo "Run from a Git checkout; use bootstrap-agent-workspace.sh first." >&2; exit 1; }
ENV_FILE="${IPTV_ENV_FILE:-}"
if [[ -z "$ENV_FILE" && -n "${IPTV_DEPLOY_DIR:-}" ]]; then ENV_FILE="$IPTV_DEPLOY_DIR/.env"; fi
if [[ -z "$ENV_FILE" ]]; then
  echo "Set IPTV_ENV_FILE to the existing deployment .env (or IPTV_DEPLOY_DIR)." >&2
  exit 1
fi
ENV_FILE="$(realpath "$ENV_FILE")"
[[ -f "$ENV_FILE" ]] || { echo "Deployment .env not found: $ENV_FILE" >&2; exit 1; }

if ! command -v docker >/dev/null 2>&1; then echo "Docker is required for local deployment." >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "Node.js is required to run project checks." >&2; exit 1; fi

echo "== Source revision =="
git -C "$WORKSPACE" rev-parse --short HEAD
git -C "$WORKSPACE" status --short

echo "== JavaScript syntax checks =="
node --check "$WORKSPACE/iptv-web/server.js"
for file in "$WORKSPACE"/iptv-web/lib/*.js "$WORKSPACE"/iptv-web/public/*.js "$WORKSPACE"/iptv-web/public/js/*.js "$WORKSPACE"/iptv-web/tools/*.js; do
  [[ -f "$file" ]] && node --check "$file"
done
echo "== Shell syntax checks =="
for file in "$WORKSPACE"/iptv-web/tools/*.sh "$WORKSPACE"/iptv-web/deploy/*.sh; do
  [[ -f "$file" ]] && bash -n "$file"
done
echo "== Unit tests =="
node --test "$WORKSPACE"/iptv-web/test/*.test.js

echo "== Docker Compose validation =="
docker compose --env-file "$ENV_FILE" -f "$WORKSPACE/iptv-web/docker-compose.yml" config --quiet

PROJECT="${IPTV_COMPOSE_PROJECT:-}"
if [[ -z "$PROJECT" ]] && docker inspect iptv-web >/dev/null 2>&1; then
  PROJECT="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' iptv-web)"
fi
if [[ -z "$PROJECT" ]]; then
  echo "Could not determine the existing Compose project name." >&2
  echo "Set IPTV_COMPOSE_PROJECT to the current project label to preserve the existing /data volume." >&2
  exit 1
fi
if [[ ! "$PROJECT" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]]; then
  echo "Invalid Compose project name: $PROJECT" >&2
  exit 1
fi

OLD_IMAGE=""
if docker inspect iptv-web >/dev/null 2>&1; then
  OLD_IMAGE="$(docker inspect --format '{{.Image}}' iptv-web)"
fi
COMPOSE=(docker compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$WORKSPACE/iptv-web/docker-compose.yml")

echo "== Build image (running container remains in place until build succeeds) =="
"${COMPOSE[@]}" build iptv-web

echo "== Apply deployment =="
"${COMPOSE[@]}" up -d --no-build iptv-web

HEALTHY=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3920/healthz >/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != "1" ]]; then
  echo "New container did not pass health check." >&2
  "${COMPOSE[@]}" ps >&2 || true
  "${COMPOSE[@]}" logs --tail=100 iptv-web >&2 || true
  if [[ -n "$OLD_IMAGE" ]]; then
    echo "Attempting rollback to the prior image." >&2
    docker tag "$OLD_IMAGE" iptv-web:1.0 || true
    "${COMPOSE[@]}" up -d --no-build iptv-web || true
  fi
  exit 1
fi

echo "== Deployment healthy =="
curl --fail --silent http://127.0.0.1:3920/healthz
echo
"${COMPOSE[@]}" ps
