# Agent deployment runbook

This document is the operational source of truth for coding agents and maintainers working on the IPTV repository. Read this before changing deployment, Compose, proxy, automation, or persistent-data behavior.

## Project facts

- Repository: `bluecarbonsales-coder/iptv`; production branch: `main`.
- Application directory: `iptv-web/`.
- Runtime: Node.js 22 on Alpine in a Docker image.
- Compose file in the repository: `iptv-web/docker-compose.yml`.
- Main service: `iptv-web`, container name `iptv-web`, host binding `127.0.0.1:3920`.
- Health check: `GET http://127.0.0.1:3920/healthz`.
- Persistent app data: named Compose volume `iptv-data`, mounted at `/data`.
- Optional player: `nodecast-tv`, host binding `127.0.0.1:3921`. Do not start this service by default on the owner's 1 GB RAM host.
- The host already has HAProxy and other services. Do not install, replace, restart, or rewrite HAProxy configuration as part of a normal app deployment.
- The production server OS is Ubuntu/Debian. Do not assume the actual server has been inspected in the current task; verify before giving destructive commands.
- The existing deployment workflow packages the contents of `iptv-web/` and extracts them into the configured `DEPLOY_DIR`. Therefore the deployed directory is the root of the app package: `Dockerfile` and `docker-compose.yml` should be directly inside it.

## Hard safety requirements

1. **Deploy only the requested service.** Use `docker compose build iptv-web` then `docker compose up -d --no-build iptv-web`. Do not use bare `docker compose up -d --build` on the low-memory production host: that can also start `nodecast-tv`.
2. **Build before replacing the running container.** A failed image build should leave the previous app container running.
3. **Preserve data and runtime secrets.** Never run `docker compose down -v`, `docker volume prune`, `docker system prune --volumes`, or delete `/data`/the `iptv-data` volume during routine deployment. Never overwrite or commit the production `.env`. The release archive excludes `.env`.
4. **Keep ports private.** The app must remain bound to loopback. Do not publish 3920/3921 to `0.0.0.0` or open firewall ports for them. Integrate the app with the existing HAProxy setup only after inspecting the actual HAProxy frontend/backend configuration and preserving other services.
5. **Secrets are secrets.** Never print, echo, commit, paste into PRs, or include in URLs/logs: `REFRESH_TOKEN`, `SOURCE_TOKEN`, `AGENT_API_TOKEN`, `GITHUB_REPO_TOKEN`, mail credentials, session/encryption keys, private SSH keys, or provider credentials. Use GitHub Actions secrets or a root/user-protected server-side environment file.
6. **SSH host verification is required.** Keep `StrictHostKeyChecking=yes`. Obtain the server host-key fingerprint through a trusted channel; do not populate `DEPLOY_KNOWN_HOSTS` from an unverified network scan alone.
7. **Do not assume available RAM/swap.** Check `free -h`, `swapon --show`, `df -h /`, `docker stats --no-stream`, and current services before heavy builds. A 1 GB host may need a modest swap file to survive image builds, but swap is not a substitute for RAM. Never change swap or reboot without checking current state.
8. **Rollback is code-only.** Roll back the container image if health checks fail; do not roll back by deleting/recreating the persistent data volume. Report if rollback could not be verified.
9. **Third-party IPTV endpoints are not rights verification.** Only configure streams/catalogs the owner is authorized to access. Do not bypass DRM, subscriptions, authentication, or geo/access controls.
10. **Keep deployment traceable.** Prefer tested commits to `main`; report the commit SHA, CI status, deployment status, health-check result, rollback outcome, and any remaining manual work. Do not claim that the VPS was changed unless the deployment job or server command actually confirms it.

## GitHub Actions deployment

Workflow: `.github/workflows/deploy.yml`.

The workflow:
1. checks JavaScript syntax;
2. installs app dependencies on the GitHub-hosted runner;
3. runs `node --test iptv-web/test/*.test.js`;
4. builds the image on the runner as an early validation check;
5. if deployment secrets exist, uploads the app package over verified SSH;
6. builds the production image on the VPS and updates **only** `iptv-web`;
7. checks `/healthz`, prints container diagnostics on failure, and attempts to restore the previous image.

Required repository Actions secrets:

- `DEPLOY_HOST`: DNS hostname or IPv4 address accepted by the workflow validation.
- `DEPLOY_USER`: SSH deployment username.
- `DEPLOY_SSH_KEY`: private key corresponding to the deployment user's installed public key.
- `DEPLOY_KNOWN_HOSTS`: verified known-hosts line for the server.
- `DEPLOY_DIR`: absolute path to the deployed app directory, with no traversal components.

Optional repository Actions variable:

- `DEPLOY_PORT`: SSH port; current workflow fallback is `9090`. Set it to the server's real SSH port.

When required secrets are missing, deployment is intentionally skipped after CI. A successful CI job alone does **not** mean production was deployed. Inspect the deployment job output.

The workflow uses a concurrency group to prevent overlapping production deploys. Keep deployment actions serialized.

## Server preflight and post-deploy checks

Before the first deployment or any change to the server setup, inspect:

```bash
cat /etc/os-release
free -h
swapon --show
df -h /
docker --version
docker compose version
sudo systemctl status haproxy --no-pager
sudo ss -lntp
docker compose ls
docker inspect iptv-web --format '{{json .Config.Labels}}' 2>/dev/null || true
```

Do not assume the current Compose project name, environment path, proxy layout, SSH port, or existing container state. If the deployment directory already contains an app, inspect it before extraction. Keep the current `.env` and Compose project identity stable so the named data volume remains attached.

After deployment:

```bash
docker compose ps
docker compose logs --tail=100 iptv-web
curl --fail --silent --show-error http://127.0.0.1:3920/healthz
free -h
docker stats --no-stream
```

Run these from the actual deployed app directory and with the same Compose project/environment settings used by that installation. If the health endpoint fails, collect logs and inspect the container before attempting manual restarts.

## Development workflow

From a writable Git checkout:

```bash
node --check iptv-web/server.js
for file in iptv-web/lib/*.js iptv-web/public/*.js iptv-web/public/js/*.js iptv-web/tools/*.js; do node --check "$file"; done
for file in iptv-web/tools/*.sh iptv-web/deploy/*.sh; do bash -n "$file"; done
node --test iptv-web/test/*.test.js
docker build -t iptv-web:agent-check ./iptv-web
```

Use `node --watch iptv-web/server.js` (from the repository root) or `node --watch server.js` from `iptv-web/` for local-only hot reload. Do not enable watch mode in production.

For the documented local server deploy helper, read its implementation first and set `IPTV_ENV_FILE` to the real deployment `.env`. It expects a normal Git checkout and detects the running Compose project to preserve the named volume:

```bash
IPTV_ENV_FILE="$IPTV_DEPLOY_DIR/.env" bash iptv-web/tools/deploy-local.sh
```

Prefer GitHub Actions for a standard production release. The local helper is for deliberate server-side testing and requires care because it operates on the live host.

## Data refresh is separate from code deployment

- Catalogue refresh: `REFRESH_HOURS` (Compose default 12 hours) and `POST /api/refresh`.
- Scheduled source synchronization: `AUTO_SOURCE_SYNC_HOURS` (default 12 hours) and `AGENT_AUTOMATION_ENABLED`.
- Source registry list: `VOD_SOURCE_LIST_URLS` or agent-managed `sourceListUrls`.
- Authenticated agent operations: `AGENT_API_TOKEN`; send it in `X-Agent-Token` or a Bearer header, never in a URL.
- The project documents a daily systemd refresh timer, but agents must inspect whether it is actually installed before adding another scheduler.

Code deployment updates the app image. It should not erase persisted playlists, VOD providers, portal shortcuts, agent settings, or audit data stored under `/data`.

## Expected agent report

After a deployment-related task, summarize:

- Files changed and reason for each change.
- Checks run and pass/fail results (do not infer a pass if not run).
- Commit/branch/PR identifiers where available.
- Whether CI deployed to the VPS or skipped because secrets were absent.
- Health endpoint result and whether rollback was attempted/verified.
- Memory/swap observations if the server was actually inspected.
- Any follow-up needed from the owner.
