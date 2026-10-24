# Agent operating instructions — IPTV Web

This repository contains a small, dependency-light Node.js IPTV/VOD service in `iptv-web/`. The owner explicitly authorizes trusted agents (including Hermes) to operate autonomously across the entire project: source registries, runtime settings, any tracked repository file, tests, dependencies, documentation, branches, commits, pull requests, CI, and deployment where credentials/workflows are available. Do not require separate per-change approval for routine project work. Use `/api/agent/v1/project/*` or `agentctl.js project-*` for GitHub-backed repository work; for the local server agent, prefer the writable checkout created by `iptv-web/tools/bootstrap-agent-workspace.sh` and use `iptv-web/tools/local-agent-deploy.sh` to deploy all backend/UI changes. The packaged instructions are in `iptv-web/AGENTS.md`.

## 1. Required connection and credentials

Set these in the deployment environment, not in prompts, chats, browser URLs, or logs:

- `IPTV_BASE_URL`: the private HTTPS URL of the deployment.
- `AGENT_API_TOKEN`: a long, random secret dedicated to the agent API.
- `GITHUB_REPO_TOKEN`: server-side GitHub App/PAT token with Contents read/write, Pull requests read/write, and Actions read/write permissions. This unlocks agent repository edits, branches, commits, PR merges, CI inspection and workflow dispatch. It must never be returned by the API or committed to Git.
- `AGENT_AUTONOMY=full`: default autonomous mode; newly discovered registry providers are probed and activated automatically. `review` stores scheduled discoveries disabled, and `off` disables background registry discovery. Authenticated agent API writes are always available; these modes configure background discovery, not human approvals.
- `VOD_SOURCE_LIST_URLS`: the default maintained TVboxorg registry is preconfigured on a fresh deployment; set comma/newline-separated URLs here to replace it with your own registry set.
- `AUTO_SOURCE_SYNC_HOURS=12`: scheduled registry sync / provider health interval.

Send `X-Agent-Token: $AGENT_API_TOKEN` on every `/api/agent/v1/*` request. `Authorization: Bearer …` also works. Never put tokens in query parameters. Keep the service behind private Cloudflare Access or equivalent access control; the service's Docker port is intended to stay bound to loopback.

Start each session with:

1. `GET /api/agent/v1/capabilities`
2. `GET /api/agent/v1/status`
3. `GET /api/agent/v1/audit?limit=50`

OpenAPI schema: `GET /api/agent/v1/openapi.json`. Full repository API: `GET /api/agent/v1/project/status`, `/tree`, `/file`; `POST /project/commit`, `/branch`, `/pr`, `/pr/:number/merge`, `/dispatch`; `GET /project/actions` and `/project/checks/:sha`.

## 2. Routine autonomous maintenance

Run a maintenance cycle with:

```http
POST /api/agent/v1/tasks/run
X-Agent-Token: <secret>
Content-Type: application/json

{"task":"maintain_sources"}
```

Supported tasks:

- `maintain_sources`: synchronize explicitly configured provider registries and health-check enabled VOD providers.
- `sync_source_lists`: fetch and reconcile configured registry JSON files.
- `check_vod_providers`: probe enabled Apple CMS/MacCMS API endpoints and update `lastChecked`, `lastError`, and `lastItemCount`.
- `refresh_live_catalog`: refresh the upstream iptv-org live-channel catalog.

The service also runs a maintenance cycle shortly after startup and then at `AUTO_SOURCE_SYNC_HOURS`. On a fresh deployment it automatically uses the maintained TVboxorg registry at `https://raw.githubusercontent.com/TVboxorg/TVbox/main/dist/official.json`; `VOD_SOURCE_LIST_URLS` or the agent-managed `sourceListUrls` setting can replace or extend that list; it can import both `sources[]`/`api_site{}`/`sites[]` VOD providers and LibreTV `liveSources[]`. In `full` mode, newly discovered endpoints must pass a compatibility probe before activation. The agent can add/remove registry URLs at runtime through `PATCH /api/agent/v1/settings`; no container rebuild is needed for these settings. The default registry periodically probes third-party URL entries; the importer independently probes compatible Apple CMS endpoints before enabling them. Neither layer grants copyright or content-redistribution rights.

## 3. Manage live and VOD sources

### Add a VOD API

```http
POST /api/agent/v1/vod/sources
X-Agent-Token: <secret>
Content-Type: application/json

{"name":"Authorized catalog","api":"https://provider.example/api.php/provide/vod","kind":"all"}
```

Accepted `kind`: `all`, `movies`, `series`, or `anime`. The server validates the URL and probes the response as an Apple CMS/MacCMS-compatible JSON VOD API before saving it.

### Import a provider directory

```http
POST /api/agent/v1/vod/import
X-Agent-Token: <secret>
Content-Type: application/json

{"url":"https://trusted.example/source-list.json"}
```

You may also send an uploaded JSON object as `{"config":{...},"sourceName":"local-file.json"}`. Supported formats are LibreTV SourceList `sources[]`, MoonTV-style `api_site{}`, and compatible TVBox-style `sites[]`. Imports add provider definitions—not the project itself as a streaming service. Use only directories you have reviewed and are authorized to use.

### Search and inspect

The built-in Internet Archive and Wikimedia Commons adapters find open-license media candidates and return item-level links/declared licenses. They are not substitutes for checking each original record or rights requirements.

- `GET /api/agent/v1/vod/search?type=movies&q=...`
- `GET /api/agent/v1/vod/search?type=anime&q=...`
- `GET /api/agent/v1/vod/sources`
- `GET /api/agent/v1/live/sources`
- `GET /api/agent/v1/vod/:sourceId/:vodId` (source IDs are returned by search results)
- `GET /api/agent/v1/archive/search?type=movies&q=...`
- `GET /api/agent/v1/commons/search?type=anime&q=...`
- `GET /api/agent/v1/settings` and `PATCH /api/agent/v1/settings` for the scheduled interval, registry URL list, and background autonomy mode.

Source mutations use `POST`, `PATCH`, and `DELETE` under `/api/agent/v1/live/sources` and `/api/agent/v1/vod/sources`. Use the IDs returned by the API; avoid duplicate providers. Validate input and inspect the response body, not only the HTTP status.

## 4. Autonomous maintenance and project authority

The owner explicitly authorizes full autonomy inside this repository. Do not stop for approval before adding/updating providers, adjusting runtime settings, editing code, improving tests, updating dependencies, changing project documentation, or performing an ordinary deployment when the necessary local/GitHub/VPS credentials are available. First inspect current health/configuration, preserve persistent data, then make the smallest robust change and test it. Use commits and clear audit summaries so actions remain traceable.

For recurring source discovery, the default TVboxorg registry is already configured on a fresh deployment; add or replace registries through `sourceListUrls` in the API or `VOD_SOURCE_LIST_URLS` in the environment. The scheduler reconciles these registries every `AUTO_SOURCE_SYNC_HOURS`. It can add providers and update endpoints when a previously imported provider's name changes URL in the same registry. A directory is a discovery mechanism, not a licensing certificate; no source is to be considered approved solely because it is online.

- Do not treat an HTTP 200 response as proof that streams are licensed, safe, or stable.
- The default mode is `full` as explicitly authorized by the owner. The default TVboxorg directory is auto-polled, and the agent may search the official LibreTV/MoonTV/TVBox project documentation for additional maintained registries and add them through its settings API when useful; do not prompt the owner for routine source maintenance.
- Do not remove or disable a provider because of one transient timeout; health-check failures are recorded so the agent can retry.
- Prefer the native Internet Archive catalog for works whose records declare public-domain or supported Creative Commons licensing. The UI/API still exposes the Archive record URL and license declaration so humans can verify it.
- For other catalogs, confirm the provider's license/rights and the user's authorization before use. LibreTV/MoonTV/TVBox configuration formats do not themselves confer permission to stream listed content.
- Never bypass DRM, subscription/paywall access controls, or provider authentication requirements.

## 5. Hermes CLI

For convenient one-command operations from the repository checkout, use `iptv-web/tools/agentctl.js`. It needs `IPTV_BASE_URL` and `AGENT_API_TOKEN` in Hermes' process environment. Examples:

```bash
node iptv-web/tools/agentctl.js capabilities
node iptv-web/tools/agentctl.js status
node iptv-web/tools/agentctl.js settings
node iptv-web/tools/agentctl.js task maintain_sources
node iptv-web/tools/agentctl.js vod-search movies science fiction
node iptv-web/tools/agentctl.js commons-search public domain animation
node iptv-web/tools/agentctl.js settings-patch '{"sourceListUrls":["https://registry.example/sources.json"],"autoSourceSyncHours":12,"autonomy":"full"}'
```

Store the token in your service/agent secret manager instead of committing it or including it in a prompt. The CLI does not need a new dependency and returns machine-readable JSON.

## 6. Reviewability and audit

Every agent API request is logged to `/data/agent-audit.jsonl` with time, action, result, and duration. The API returns recent entries at `GET /api/agent/v1/audit`. It intentionally avoids writing provider URLs or tokens to the log. Report a concise summary of actions performed, providers added/updated, failures, and pending-review entries.

## 7. Project-wide authority: code, UI, tests, dependencies, and deployment

This is the owner's project. A trusted local agent has full authority to inspect, add, edit, rename, and delete any project file needed for the requested work: frontend UI/HTML/CSS/JavaScript, backend APIs, data adapters, tests, dependencies/build tooling, documentation, environment templates, Docker files, and every `.github/workflows/*` workflow. Do not impose a repository-path allowlist, require approval for ordinary file changes, or stop at the source-management API. Use the local filesystem and shell tools normally available to the agent. The HTTP project API is an additional option, not a replacement for the local checkout.

### Bootstrap the local working tree on the deployment server

The release directory produced by CI is a deployment package, not the Git working tree. On the deployment host, use the helper shipped in the release to clone the private repository into a writable checkout. Set the real paths for this host:

```bash
export IPTV_DEPLOY_DIR=/path/to/the/current/deployment-directory
export IPTV_ENV_FILE="$IPTV_DEPLOY_DIR/.env"
export IPTV_WORKSPACE_DIR="$HOME/src/iptv"
bash "$IPTV_DEPLOY_DIR/tools/bootstrap-agent-workspace.sh"
cd "$IPTV_WORKSPACE_DIR"
```

The deployment `.env` must contain `GITHUB_REPO_TOKEN`; the bootstrap helper uses it without embedding the token in the Git remote or saving it to `.git-credentials`. It configures a per-checkout credential helper so the local agent can fetch and push. The fine-grained token needs Contents read/write, Workflows read/write, Pull requests read/write, and Actions read/write permissions for this repository. Keep that token in the host's protected deployment `.env`, not in code or prompts.

After bootstrapping, the agent can work in a **normal local Git checkout**. Change every area of the repository, run commands, install dependencies when appropriate, run tests, commit and push changes. Pushes to `main` run CI and the deployment workflow without an additional human approval. Use a branch/PR when it improves quality or when branch protection requires it; a PR is not a mandatory approval gate for normal autonomous work.

### Validation and deployment

Run at least these project checks, adding tests/build/lint/security audits appropriate to the change:

```bash
node --check iptv-web/server.js
for file in iptv-web/lib/*.js iptv-web/public/*.js iptv-web/public/js/*.js iptv-web/tools/*.js; do node --check "$file"; done
for file in iptv-web/tools/*.sh iptv-web/deploy/*.sh; do bash -n "$file"; done
node --test iptv-web/test/*.test.js
docker build -t iptv-web:agent-check ./iptv-web
```

The host-side local deploy helper validates the source, builds before replacing the running container, reads the real deployment `.env`, reuses the current Compose project name to preserve its named volume, and checks health afterward:

```bash
IPTV_ENV_FILE="$IPTV_DEPLOY_DIR/.env" bash iptv-web/tools/deploy-local.sh
```

Prefer committing/pushing to `main` and letting the repository's CI/deploy workflow roll out a checked revision. Use the local deploy helper when explicitly testing the local working tree against the running host. Do not delete or recreate persistent `/data` volumes during deployment. A deployment failure must be reported with logs and the result of the health check. The dedicated project API at `/api/agent/v1/project/*` can also edit any repository path, create commits/branches/PRs, merge PRs, inspect CI, and dispatch deployment workflows; configure `GITHUB_REPO_TOKEN` in the deployment `.env` to enable it.
