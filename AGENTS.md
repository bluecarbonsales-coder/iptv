# Agent operating instructions — IPTV Web

This repository contains a small, dependency-light Node.js IPTV/VOD service in `iptv-web/`. The owner explicitly authorizes trusted agents (including Hermes) to operate autonomously across the entire project: source registries, runtime settings, application code, tests, dependencies, documentation, deployment configuration, and deployment where credentials/tools are available. Do not require separate per-change approval for routine project work. Use the agent API for runtime operations and your normal repository/filesystem/shell tools for code changes.

## 1. Required connection and credentials

Set these in the deployment environment, not in prompts, chats, browser URLs, or logs:

- `IPTV_BASE_URL`: the private HTTPS URL of the deployment.
- `AGENT_API_TOKEN`: a long, random secret dedicated to the agent.
- `AGENT_AUTONOMY=full`: default autonomous mode; newly discovered registry providers are probed and activated automatically. `review` stores scheduled discoveries disabled, and `off` disables background registry discovery. Authenticated agent API writes are always available; these modes configure background discovery, not human approvals.
- `VOD_SOURCE_LIST_URLS`: optional comma/newline-separated URLs for JSON registries explicitly trusted by the operator.
- `AUTO_SOURCE_SYNC_HOURS=12`: scheduled registry sync / provider health interval.

Send `X-Agent-Token: $AGENT_API_TOKEN` on every `/api/agent/v1/*` request. `Authorization: Bearer …` also works. Never put tokens in query parameters. Keep the service behind private Cloudflare Access or equivalent access control; the service's Docker port is intended to stay bound to loopback.

Start each session with:

1. `GET /api/agent/v1/capabilities`
2. `GET /api/agent/v1/status`
3. `GET /api/agent/v1/audit?limit=50`

OpenAPI schema: `GET /api/agent/v1/openapi.json`.

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

The service also runs a maintenance cycle shortly after startup and then at `AUTO_SOURCE_SYNC_HOURS`. Registry synchronization uses `VOD_SOURCE_LIST_URLS` or the agent-managed `sourceListUrls` setting; it can import both `sources[]`/`api_site{}`/`sites[]` VOD providers and LibreTV `liveSources[]`. In `full` mode, newly discovered endpoints must pass a compatibility probe before activation. The agent can add/remove registry URLs at runtime through `PATCH /api/agent/v1/settings`; no container rebuild is needed for these settings.

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

For recurring source discovery, configure `sourceListUrls` through the API or `VOD_SOURCE_LIST_URLS` in the environment. The scheduler reconciles these registries every `AUTO_SOURCE_SYNC_HOURS`. It can add providers and update endpoints when a previously imported provider's name changes URL in the same registry. A directory is a discovery mechanism, not a licensing certificate; no source is to be considered approved solely because it is online.

- Do not treat an HTTP 200 response as proof that streams are licensed, safe, or stable.
- The default mode is `full` as explicitly authorized by the owner. The agent can switch background discovery mode through its settings API when needed; do not prompt the owner for routine source maintenance.
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

## 7. Project-wide code changes and deployment

The agent is authorized to change any project file needed to accomplish the owner's task. Use the available repository checkout and filesystem/shell tools to modify code; the HTTP API deliberately exposes project operations, not an arbitrary public shell endpoint. Add or update tests, run:

```bash
node --check iptv-web/server.js
for file in iptv-web/lib/*.js iptv-web/public/*.js iptv-web/public/js/*.js; do node --check "$file"; done
node --test iptv-web/test/*.test.js
```

Commit clear, focused changes and push them to the configured repository. When the deployment environment is available and the change passes tests, deploy/restart the application using the project's existing deployment path without waiting for another approval. Preserve `/data` and secrets, avoid destructive migrations without a backup, and report the commit, CI result, and deployment health. Add dependencies when they materially improve reliability, security, agent interoperability, or maintainability; document why.
