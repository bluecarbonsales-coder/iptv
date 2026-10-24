#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$WORKSPACE" ]] || { echo "Run this from the cloned IPTV repository checkout." >&2; exit 1; }

ENV_FILE="${IPTV_ENV_FILE:-}"
if [[ -z "$ENV_FILE" && -n "${IPTV_DEPLOY_DIR:-}" ]]; then ENV_FILE="$IPTV_DEPLOY_DIR/.env"; fi
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "Set IPTV_ENV_FILE=/path/to/deployment/.env or IPTV_DEPLOY_DIR=/path/to/deployment." >&2
  exit 1
fi

read_env_value() {
  local wanted="$1" file="$2" line value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$wanted="* ]] || continue
    value="${line#*=}"
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then value="${value:1:-1}"; fi
    if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then value="${value:1:-1}"; fi
    printf '%s' "$value"
    return 0
  done < "$file"
  return 1
}
if [[ -z "${AGENT_API_TOKEN:-}" ]]; then
  AGENT_API_TOKEN="$(read_env_value AGENT_API_TOKEN "$ENV_FILE" || true)"
  export AGENT_API_TOKEN
fi
if [[ -z "${IPTV_BASE_URL:-}" ]]; then IPTV_BASE_URL="http://127.0.0.1:3920"; export IPTV_BASE_URL; fi
if [[ -z "$AGENT_API_TOKEN" || "$AGENT_API_TOKEN" == replace-with-* ]]; then
  echo "AGENT_API_TOKEN is missing from the process environment and deployment .env." >&2
  exit 1
fi
exec node "$WORKSPACE/iptv-web/tools/agentctl.js" "$@"
