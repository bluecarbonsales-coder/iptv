# Platform API and Agent Integration Guide

This guide describes the APIs that are implemented in IPTV Web, where to find their live schemas, how browser accounts differ from agent authentication, and how to call the agent endpoints safely.

## 1. API entry points

Set `IPTV_BASE_URL` to the private HTTPS origin for your own deployment. Do not assume the example deployment hostname is your server.

| Entry point | Purpose |
|---|---|
| `GET /api/v1` | Human- and machine-readable API index grouped by service |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description of the unified platform API |
| `GET /api/v1/health` | Application health and catalogue counts |
| `/api/v1/agent/*` | Preferred unified agent API; uses the shared admin HTTP Basic credentials |
| `/api/agent/v1/*` | Legacy agent API used by existing agent tools; retained for compatibility |
| `/api/*` | Existing service-specific routes, including IPTV, Radio, portal, account, and mail APIs |

The OpenAPI document is generated from `iptv-web/lib/platform-api-docs.js`. It is the best route index for the unified API, but not every older route is represented there. In particular, the browser owner-account endpoints under `/api/account/*` and legacy agent routes are separate compatibility surfaces.

## 2. Authentication: browser account vs. agent

These are different authentication mechanisms and serve different clients.

### Shared website account

The Theatre, IPTV, Radio and other browser pages use the same owner login. Sign-in is performed through `POST /api/account/login`; the server sets an HttpOnly session cookie named `iptv_owner_session`. The browser sends that cookie automatically to the owner-account routes.

- `GET /api/account/session` — check whether the browser is signed in.
- `POST /api/account/login` — sign in with JSON `{"username":"…","password":"…"}`.
- `POST /api/account/logout` — end the browser session.
- `POST /api/account/credentials` — change the owner credentials after verifying the current credentials.
- `GET /api/account/history` and `GET /api/account/history?type=theatre` — read the signed-in account's shared media history.
- `POST /api/account/history` — record shared IPTV, Radio or Theatre history.

These endpoints require the owner session except for login. They are not a general-purpose agent token.

### Agent and administration authentication

Agent endpoints and protected source-management operations use **HTTP Basic authentication with the admin username and password** configured for `/admin.html`. X-Agent-Token and Bearer-token authentication are disabled.

Keep credentials in a protected server-side environment or secret store. Do not put credentials in URLs, source files, browser JavaScript, issue comments, or logs. Prefer private HTTPS and restrict access to the service with Cloudflare Access or an equivalent access gateway. The Node service port should remain private/loopback-bound in deployment.

For shell examples below, export the variables in your trusted shell without committing them:

```sh
export IPTV_BASE_URL="https://your-private-host.example"
export ADMIN_USERNAME="your-admin-user"
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
```

Example authenticated request:

```sh
curl --fail-with-body --silent --show-error \
  -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  "$IPTV_BASE_URL/api/v1/agent/capabilities"
```

Do not use the development credentials sometimes shown in older setup notes on a production deployment; change them before exposing the service.

## 3. Start an agent session

A client should discover capabilities and current health before making changes. These calls are read-only:

```sh
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$IPTV_BASE_URL/api/v1/agent/capabilities"
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$IPTV_BASE_URL/api/v1/agent/status"
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$IPTV_BASE_URL/api/v1/agent/audit?limit=50"
```

The same capabilities/status/audit operations exist on the legacy `/api/agent/v1/*` path for compatible tools. Prefer `/api/v1/agent/*` for new integrations.

### Run a maintenance task

```sh
curl --fail-with-body -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' \
  -X POST "$IPTV_BASE_URL/api/v1/agent/tasks/run" \
  -d '{"task":"maintain_sources"}'
```

Supported task names currently include:

- `maintain_sources` — synchronize configured registries and check enabled VOD providers.
- `sync_source_lists` — fetch and reconcile configured source-list JSON registries.
- `check_vod_providers` — probe enabled Apple CMS/MacCMS-compatible providers.
- `refresh_live_catalog` — refresh the upstream IPTV-org live-channel catalogue.

The scheduler also runs configured maintenance automatically. `AGENT_AUTONOMY` controls background discovery behavior (`full`, `review`, or `off`); it does not replace authentication for API writes.

## 4. Common agent operations

All examples use `/api/v1/agent` and HTTP Basic authentication.

### Inspect or add a Theatre provider

```sh
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  "$IPTV_BASE_URL/api/v1/agent/sources/theatre"

curl --fail-with-body -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' -X POST \
  "$IPTV_BASE_URL/api/v1/agent/sources/theatre" \
  -d '{"name":"Authorized VOD catalogue","api":"https://provider.example/api.php/provide/vod","kind":"all"}'
```

The provider must expose a compatible Apple CMS/MacCMS JSON VOD API. The server validates and probes it before saving. Only add sources you are authorized to use; a successful response or an online URL does not establish streaming rights.

### Search Theatre titles and read episode options

```sh
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  "$IPTV_BASE_URL/api/v1/agent/theatre/search?type=movies&q=documentary"

curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  "$IPTV_BASE_URL/api/v1/agent/theatre/titles/SOURCE_ID/VOD_ID"
```

Use the exact `sourceId` and `vodId` returned by search results. The detail response includes the provider's normalized title and playable episode/source options when the provider supplies them.

### Read or change settings

```sh
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" "$IPTV_BASE_URL/api/v1/agent/settings"

curl --fail-with-body -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' -X PATCH \
  "$IPTV_BASE_URL/api/v1/agent/settings" \
  -d '{"autoSourceSyncHours":12,"autonomy":"full"}'
```

Only send supported settings and inspect the returned JSON before relying on a change.

### Agent project operations

The unified agent API also exposes repository/workflow operations:

- `GET /api/v1/agent/project/status`
- `GET /api/v1/agent/project/tree`
- `GET /api/v1/agent/project/file`
- `POST /api/v1/agent/project/branch`
- `POST /api/v1/agent/project/commit`
- `POST /api/v1/agent/project/pr`
- `POST /api/v1/agent/project/pr/{number}/merge`
- `GET /api/v1/agent/project/actions`
- `GET /api/v1/agent/project/checks/{sha}`
- `POST /api/v1/agent/project/dispatch`

These GitHub-backed operations additionally require the server-side `GITHUB_REPO_TOKEN` configured with the documented repository Contents, Pull requests, Workflows and Actions permissions. The token is not sent by the client and must never be returned by an API response.

## 5. Service API overview

The unified API base is `/api/v1`. The live OpenAPI document contains the current route list and authentication labels.

| Area | Common endpoints | What they do |
|---|---|---|
| Sources | `GET /sources`, `GET /sources/{type}`, `POST /sources/{type}`, `PATCH /sources/{type}/{id}`, `DELETE /sources/{type}/{id}` | Manage Radio, IPTV and Theatre source definitions; writes require admin authentication |
| IPTV | `GET /iptv/meta`, `GET /iptv/channels`, `GET /iptv/channels/{id}`, `GET /iptv/export.m3u`, `POST /iptv/refresh` | Browse channels, retrieve streams, export M3U and refresh the catalogue |
| Radio | `GET /radio/stations`, `GET /radio/options`, `GET /radio/resolve/{uuid}`, `GET /radio/stream/{ticket}` | Search stations and resolve short-lived playback tickets |
| Theatre | `GET /theatre/titles`, `GET /theatre/titles/{sourceId}/{vodId}` | Search VOD catalogues and read playable episodes |
| Portal | `GET /portal/services`, `GET /portal/availability`, and protected portal-service writes | List service shortcuts and check their server-side availability |
| Metadata | `GET /metadata/search`, `GET /metadata/title`, `GET /metadata/tvmaze` | Search film/TV metadata; metadata records do not guarantee playable streams |
| Visitor history | `GET /history/{visitorId}`, `POST /history/{visitorId}` | Store anonymous browser search/watch events under a client-generated visitor ID |
| Agent | `/agent/capabilities`, `/agent/status`, `/agent/tasks/run`, `/agent/project/*` | Operate maintenance, provider sources, audit, and authorized repository workflows |

Mail Workspace uses its own mailbox/session rules. Use `/api/v1/mail/login` and the returned session cookie for mail endpoints; do not substitute the owner-account or HTTP Basic session for the mail session.

## 6. Response handling and troubleshooting

- Send JSON with `Content-Type: application/json` on POST/PATCH/PUT requests.
- Treat non-2xx responses as failures and inspect the JSON `error` field. Common statuses include `400` for invalid input, `401` for missing/invalid authentication, `403` for access denial, `409` for duplicate/conflicting source definitions, `429` for rate limits, and `503` if the unified API has been disabled by an administrator.
- Do not assume an HTTP 200 means a stream is playable, licensed, stable, or available in every region. Check the returned provider/source status and playback result.
- `GET /api/v1/openapi.json` is the machine-readable reference for unified routes. `GET /api/v1` provides a grouped overview. Check these against the deployed version before using an endpoint.
- `GET /api/v1/agent/audit` shows recent agent actions. Avoid logging credentials, tokens, or unnecessary provider secrets.
- Keep external-source access behind the project's URL validation, redirect checks, and SSRF safeguards. Do not add arbitrary URL relay parameters or bypass provider authentication, DRM, or paywalls.

## 7. Where the implementation lives

- `iptv-web/server.js` — HTTP route registration and auth middleware.
- `iptv-web/lib/platform-api-docs.js` — unified route inventory and generated OpenAPI document.
- `iptv-web/lib/agent.js` — agent capabilities, tasks, source management and project operations.
- `iptv-web/lib/account-history.js` — shared signed-in media history persistence.
- `iptv-web/lib/watch-history.js` — visitor-scoped search/watch history.
- `iptv-web/AGENTS.md` and root `AGENTS.md` — agent operating and deployment runbooks.
