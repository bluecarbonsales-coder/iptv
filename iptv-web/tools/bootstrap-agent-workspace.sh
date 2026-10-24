#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-bluecarbonsales-coder/iptv}"
WORKSPACE="${IPTV_WORKSPACE_DIR:-$HOME/src/iptv}"
ENV_FILE="${IPTV_ENV_FILE:-}"
if [[ -z "$ENV_FILE" && -n "${IPTV_DEPLOY_DIR:-}" ]]; then
  ENV_FILE="$IPTV_DEPLOY_DIR/.env"
fi
if [[ -n "$ENV_FILE" ]]; then
  ENV_FILE="$(realpath "$ENV_FILE")"
  [[ -f "$ENV_FILE" ]] || { echo "IPTV_ENV_FILE does not exist: $ENV_FILE" >&2; exit 1; }
fi

read_env_value() {
  local wanted="$1" file="$2" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$wanted="* ]] || continue
    value="${line#*=}"
    if [[ "$value" == \"*\" && "${#value}" -ge 2 ]]; then value="${value:1:-1}"; fi
    if [[ "$value" == \'*\' && "${#value}" -ge 2 ]]; then value="${value:1:-1}"; fi
    printf '%s' "$value"
    return 0
  done < "$file"
  return 1
}

TOKEN="${GITHUB_REPO_TOKEN:-}"
if [[ -z "$TOKEN" && -n "$ENV_FILE" ]]; then
  TOKEN="$(read_env_value GITHUB_REPO_TOKEN "$ENV_FILE" || true)"
fi
if [[ -z "$TOKEN" ]] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" || "$TOKEN" == replace-with-* ]]; then
  echo "A GitHub token with repository Contents read/write and Actions permission is required." >&2
  echo "Set GITHUB_REPO_TOKEN securely or set IPTV_ENV_FILE to the deployment .env containing it." >&2
  exit 1
fi

mkdir -p "$(dirname "$WORKSPACE")"
WORKSPACE="$(mkdir -p "$(dirname "$WORKSPACE")" && realpath "$(dirname "$WORKSPACE")")/$(basename "$WORKSPACE")"

if [[ -d "$WORKSPACE/.git" ]]; then
  REMOTE="$(git -C "$WORKSPACE" remote get-url origin 2>/dev/null || true)"
  if [[ "$REMOTE" != "https://github.com/$REPOSITORY.git" && "$REMOTE" != "git@github.com:$REPOSITORY.git" ]]; then
    echo "Existing workspace origin does not match $REPOSITORY: $REMOTE" >&2
    exit 1
  fi
  echo "Repository checkout already exists: $WORKSPACE"
else
  [[ ! -e "$WORKSPACE" ]] || { echo "Workspace path exists but is not a Git checkout: $WORKSPACE" >&2; exit 1; }
  ASKPASS="$(mktemp)"
  trap 'rm -f "$ASKPASS"' EXIT
  cat > "$ASKPASS" <<'ASKPASS_SCRIPT'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$GITHUB_REPO_TOKEN" ;;
  *) exit 1 ;;
esac
ASKPASS_SCRIPT
  chmod 700 "$ASKPASS"
  export GITHUB_REPO_TOKEN="$TOKEN" GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0
  git clone "https://github.com/$REPOSITORY.git" "$WORKSPACE"
  rm -f "$ASKPASS"
  trap - EXIT
fi

if [[ -n "$ENV_FILE" ]]; then
  HELPER="$WORKSPACE/.git/iptv-git-credential-helper.sh"
  cat > "$HELPER" <<'CREDENTIAL_HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
ENV_FILE="$1"
OPERATION="${2:-}"
[[ "$OPERATION" == "get" ]] || exit 0
PROTOCOL=""
HOST=""
while IFS='=' read -r key value; do
  case "$key" in
    protocol) PROTOCOL="$value" ;;
    host) HOST="$value" ;;
  esac
done
[[ "$PROTOCOL" == "https" && "$HOST" == "github.com" ]] || exit 0
TOKEN=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" == GITHUB_REPO_TOKEN=* ]] || continue
  TOKEN="${line#*=}"
  if [[ "$TOKEN" == \"*\" && "${#TOKEN}" -ge 2 ]]; then TOKEN="${TOKEN:1:-1}"; fi
  if [[ "$TOKEN" == \'*\' && "${#TOKEN}" -ge 2 ]]; then TOKEN="${TOKEN:1:-1}"; fi
  break
done < "$ENV_FILE"
[[ -n "$TOKEN" && "$TOKEN" != replace-with-* ]] || exit 0
printf 'username=x-access-token\npassword=%s\n\n' "$TOKEN"
CREDENTIAL_HELPER
  chmod 700 "$HELPER"
  git -C "$WORKSPACE" config --local credential.helper "!\\"$HELPER\\" \\"$ENV_FILE\\""
fi
git -C "$WORKSPACE" config --local user.name "${GIT_AUTHOR_NAME:-IPTV Project Agent}"
git -C "$WORKSPACE" config --local user.email "${GIT_AUTHOR_EMAIL:-iptv-project-agent@users.noreply.github.com}"

echo
echo "Agent workspace ready: $WORKSPACE"
echo "Repository: $REPOSITORY"
echo "Branch: $(git -C "$WORKSPACE" branch --show-current)"
echo "Working tree:"
git -C "$WORKSPACE" status --short
echo
echo "This is a normal writable Git checkout. The local agent can inspect and edit every repository file, including public UI assets, backend code, tests, dependencies, documentation, and GitHub Actions workflows."
echo "To make changes permanent: edit files, run tests, git add/commit, then git push. A push to main runs CI and the configured deploy workflow."
