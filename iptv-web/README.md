# IPTV Web

A self-hosted media and service portal: browse live TV/VOD, listen to worldwide radio, and launch your favorite self-hosted apps or external websites.

Live deployment: **https://iptv.nafisainternational.com**

## Simple source settings

Open **https://iptv.nafisainternational.com/admin.html** (or `/admin.html` on your own server).

- **Username:** `admin`
- **Password:** `0809`

The page has three separate lists: **Radio**, **IPTV**, and **Theatre**. Each list has an **Enable all** button plus individual **Enable / Disable** and **Delete** buttons. You can add radio stream URLs, IPTV M3U/M3U8 playlist URLs, and Theatre Apple CMS/MacCMS video API URLs. Theatre also has an option to import a source-list JSON URL. You do not need to enter an API token to manage these sources.

All sources are enabled once on a fresh install or the first upgrade after this change. After that, individual on/off choices you make are saved and stay saved when the app restarts. The settings are stored in the Docker data volume:

| File | Contains |
|---|---|
| `radio-sources.json` | Radio Browser on/off setting and your added radio stations |
| `sources.json` | IPTV M3U/M3U8 playlists |
| `vod-sources.json` | Theatre video API providers |

The simple login defaults are intended for your current testing stage. You can change them with `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the server environment if needed.


## Service portal homepage

The root path `/` is now a configurable service portal, not a player-specific landing page. It provides a searchable directory of self-hosted apps and external websites, category filters, responsive cards, and authenticated add/edit/delete/reorder controls. Existing IPTV functionality remains available at **`/watch.html`**.

The initial directory includes the player, known Nafisa service shortcuts, and examples such as ChatGPT, GitHub, Cloudflare, YouTube, and Wikipedia. Edit or delete any example to match the services you actually use. It also includes **SeedHub** and the official **Streambert** project link under *Media resources*. SeedHub is a web catalog; Streambert is a desktop-app repository—not an Apple CMS/MacCMS VOD API—so these are external shortcuts rather than falsely advertised native providers. Service definitions persist in `DATA_DIR/portal-services.json` (in Docker, `/data/portal-services.json`), separate from the image and preserved with the existing data volume.

Manage homepage links, Radio, IPTV and Theatre sources, source health and playback defaults from **`/admin.html`**, using the shared admin login (`admin / 0809` by default). Protected API writes use HTTP Basic admin credentials; API-token and bearer-token authentication are disabled. Management calls use the API below:

| Route | Purpose |
|---|---|
| `GET /api/portal/availability` | Live HTTP availability and response latency for each portal shortcut; includes the fastest responding media-resource site |
| `GET /api/portal/availability?refresh=1` | Request an availability refresh (cooldown and in-flight scan limits still apply) |
| `GET /api/portal/services` | Public service directory |
| `GET /api/portal/services?manage=1` | Validate Settings admin login and return the directory |
| `POST /api/portal/services` | Add a link (HTTP Basic admin login required) |
| `PATCH /api/portal/services/:id` | Edit a link (HTTP Basic admin login required) |
| `DELETE /api/portal/services/:id` | Remove a link (HTTP Basic admin login required) |

Links accept same-site relative paths or absolute HTTP(S) URLs. Each card opens safely in a new tab. Removing a link only removes its shortcut; it does not modify or delete the linked service. Every card always shows a reachability state: local, online, slow, restricted, not found, offline, or checking. External sites are probed with a bounded HEAD request (falling back to a one-byte range GET when HEAD is blocked), SSRF-checked on every redirect, with caching and limited concurrency. The *Fastest responding media resource* banner compares SeedHub and Streambert by HTTP response latency measured from the application server; that is **not** an end-user speed test or a guarantee of media-stream throughput. HTTP 403/429 is reported as restricted/rate-limited instead of being mislabeled offline.

The portal uses plain HTML, CSS, browser JavaScript, and the existing Node standard-library server. It has no npm dependencies and does not rely on OpenResty-specific features or any single player framework. It can sit behind Cloudflare Tunnel/Access, OpenResty, Nginx, Caddy, Traefik, or another ingress that forwards requests to the app. Keep the Node port private as in the existing deployment. If the directory itself should be private, protect the homepage with Cloudflare Access or equivalent; the directory's URLs and names are visible to visitors who can reach the public homepage.

```
┌────────────┐   https   ┌──────────────┐   loopback  ┌────────────────────┐
│  browser   │ ────────► │  openresty   │ ──────────► │  node (this app)   │
│  hls.js    │ ◄──────── │  (host vhost)│ ◄────────── │  catalog + relay   │
└────────────┘   /hls    └──────────────┘             └─────────┬──────────┘
                                                                │ plain http/https
                                                                ▼
                                                     third-party IPTV origins
```

## Public radio

The standalone **`/radio.html`** page browses the community-maintained [Radio Browser](https://www.radio-browser.info/) station directory. It supports station-name search, country/language/genre filters, popular and alphabetical sorting, paging, local favorites, a persistent audio control bar, and desktop/mobile media-session controls where supported. This is an open radio directory—not a curated list limited to government-funded/public-service broadcasters—and individual station availability, location restrictions, and listening rights depend on each broadcaster.

The app discovers Radio Browser API mirrors through the documented `_api._tcp.radio-browser.info` DNS SRV record, falls back to the documented DNS A/PTR discovery path, retries other mirrors, and caches search results briefly and country/language/genre dictionaries longer to reduce API load. No API key or extra npm package is required. The server sends a descriptive User-Agent and calls Radio Browser's station click-counter endpoint when resolving playback.

Playback prefers HTTPS streams directly in the browser, avoiding unnecessary VPS bandwidth. HLS streams use the existing same-origin HLS relay so manifests and segments can be rewritten safely. HTTP-only audio streams use a random, short-lived ticket created from a valid station UUID; they cannot be used as arbitrary-URL proxy requests. Direct HTTPS playback automatically falls back to this bounded relay if the browser cannot play a broadcaster's stream. The relay follows redirects through the project's SSRF guard, caps active relay streams, and accepts only audio-like content types. Availability may still vary by station, network, codec, or region.

Radio endpoints:

| Route | Purpose |
|---|---|
| `GET /api/radio/stations?q=&countrycode=&language=&tag=&order=&limit=&offset=` | Search community stations with bounded paging and filters |
| `GET /api/radio/options?type=countries\|languages\|tags` | Country, language, and genre filter lists |
| `GET /api/radio/resolve/:uuid` | Count the station click and resolve its current stream URL |
| `GET /api/radio/stream/:ticket` | Stream through a short-lived ticket when proxy playback is needed |

## Why the relay exists

Pointing a browser straight at IPTV stream URLs fails most of the time:

1. **CORS** — origins rarely send `Access-Control-Allow-Origin`, so hls.js's fetches are
   rejected by the browser.
2. **Mixed content** — the page is HTTPS, and roughly a quarter of the catalog's streams
   are plain `http://`; browsers refuse to load those from an HTTPS page.
3. **Geo/referrer blocks** — many origins only answer from certain countries, or require a
   specific `Referer`/`User-Agent` (iptv-org records both per stream).

`GET /hls?u=<url>` fixes all three: the server fetches the manifest, rewrites **every** URI
inside it (`#EXTINF` segment URLs, `EXT-X-KEY`, `EXT-X-MEDIA`, `EXT-X-MAP`, master-playlist
variants) to point back at the relay, and streams the segments through with permissive CORS
headers, `Range` passthrough and no buffering. The browser only ever talks to this server.

Measured effect (same 40-stream sample, `tools/probe.js`):
`48%` of streams produced a playable manifest fetched from mainland China vs `57%` from the
Japan-hosted relay — and geo-blocked channels that return `504`/`403` on the direct path
play fine through it.

## Features

- **Catalogue** — 10,313 channels / 15,673 stream URLs, rebuilt from the iptv-org API.
- **Filtering** — country (with a type-to-find box), 30 categories, minimum quality,
  logo-only, optional adult channels, three sort orders; state lives in the URL hash so a
  filtered view is shareable.
- **Search** — diacritic-insensitive ranked matching over name, alternate names and id.
- **Player** — hls.js, quality-level picker, per-channel source picker (channels carry up
  to 15 streams), automatic fallback to the next source on a fatal manifest/media error,
  favourite + recents, copy stream URL, relay on/off.
- **Any M3U playlist** — import by URL (server-side fetch, no CORS) or local file (parsed
  in the browser); imports are kept in `localStorage`.
- **Movies, series, anime and VOD** — separate sections with multi-provider search, poster cards,
  details and episode selection for Apple CMS / MacCMS-compatible VOD APIs.
- **Persistent VOD providers** — add, enable/disable and remove named providers. Provider settings
  live in the Docker data volume; provider APIs are probed before being saved.
- **Provider-list import** — import a hosted JSON list URL or upload a downloaded JSON file in LibreTV
  SourceList format (`sources`), MoonTV `config.json` format (`api_site`), or a TVBox-style `sites` array
  containing compatible Apple CMS APIs. Imported providers are probed before they are saved; the probe
  does not determine whether the content is licensed for redistribution.
- **Open-license video catalogs** — built-in Internet Archive and Wikimedia Commons adapters search public-domain / CC metadata and return compatible video files when available. Each result links to its original item/license page; non-commercial CC licenses are excluded from automatic results.
- **Agent-first management** — documented OpenAPI endpoints, a dependency-free Hermes CLI, authenticated CRUD, mutable runtime settings, automatic configured-registry synchronization, provider health checks, task execution, and an audit log. Trusted agents can update project code through their repository workspace.
- **M3U export** — `/api/export.m3u` mirrors the current filters, and can emit either the
  original stream URLs or relay URLs (`&proxy=1`) for use in VLC/Kodi.
- **Bilingual UI** — English / 简体中文.
- **Service portal homepage** — configurable service directory at `/`, with `/watch.html` preserving the IPTV player; persistent links, category filters, search, and admin-password-protected link management.
- **Resource availability and fastest-response recommendation** — a status badge on every home-page shortcut, HTTP latency checks, and an automatically updated recommendation among the media resources.
- **World radio** — `/radio.html`, searchable Radio Browser directory, station filters, persistent favorites, HLS playback, and limited fallback relay for incompatible HTTP/HTTPS streams.
- **No dependencies** — plain Node stdlib, no npm install, no build step.

## API

### One common API entry (recommended)

The whole site is available under one base path:

- **API index:** `/api/v1`
- **Full API definition:** `/api/v1/openapi.json`
- **Absolute base URL:** `https://iptv.nafisainternational.com/api/v1` (replace the domain when self-hosting)

The common API supports browser CORS preflight (`OPTIONS`) so another web app can call it. Public reads and playback are open; management endpoints use the same admin Basic login as Settings.

The Settings page at `/admin.html` has an **API** tab. It lists the endpoint groups and includes a small request tester. You can also connect another app to these endpoints directly.

Source management and advanced endpoints use HTTP Basic authentication with the same username/password as Settings (`ADMIN_USERNAME` and `ADMIN_PASSWORD`). Public read and playback routes remain open, and Mail Workspace uses its own session login. Legacy `/api/agent/v1/*` routes use the same Basic login. Header tokens and bearer-token access are disabled.

The common source API covers all three source types:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/sources` | List Radio, IPTV and Theatre sources together |
| `GET` | `/api/v1/sources/radio`, `/iptv`, or `/theatre` | List one source group |
| `POST` | `/api/v1/sources/radio`, `/iptv`, or `/theatre` | Add a source |
| `POST` | `/api/v1/sources/{type}/enable-all` | Enable every source in one group |
| `PATCH` | `/api/v1/sources/{type}/{id}` | Rename, edit or enable/disable a source |
| `DELETE` | `/api/v1/sources/{type}/{id}` | Delete a source |
| `POST` | `/api/v1/sources/theatre/import` | Import a Theatre provider list |

Use `radio`, `iptv`, or `theatre` as the source type. The same common API also includes IPTV catalogue/playlist playback, radio search and playback, Theatre title search and episode lookup, homepage shortcuts, navigation, metadata, Mail Workspace, visitor-history endpoints, health, and the advanced agent API.

Example: list all source groups from a terminal (set the two environment variables to your admin login first):

```sh
export ADMIN_USERNAME='your-admin-username'
export ADMIN_PASSWORD='your-admin-password'
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" https://iptv.nafisainternational.com/api/v1/sources
```

Example: add an IPTV playlist:

```sh
curl -u "$ADMIN_USERNAME:$ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -d '{"name":"My playlist","url":"https://example.com/playlist.m3u"}' \
  https://iptv.nafisainternational.com/api/v1/sources/iptv
```

The original endpoints listed below remain available for backward compatibility. New integrations should start at `/api/v1`.

| Route | Purpose |
|---|---|
| `GET /api/meta` | countries / categories / qualities with counts, catalogue timestamp |
| `GET /api/channels` | `q`, `country`, `category`, `minQuality`, `hasLogo`, `nsfw`, `ids`, `sort`, `page`, `limit` |
| `GET /api/channel/:id` | one channel with every stream URL, quality, referrer, user-agent, labels |
| `GET /api/playlist?u=` | import an external M3U (server-side fetch + parse) |
| `GET /api/vod?type=&q=` | search configured VOD APIs and the built-in Internet Archive adapter for `all`, `movies`, `series`, or `anime` (includes Internet Archive and Wikimedia Commons results) |
| `GET /api/vod/:sourceId/:vodId` | resolve details and episodes for a VOD title |
| `GET /api/vod/sources` | list VOD providers (requires HTTP Basic admin login) |
| `POST /api/vod/sources` | validate and add Apple CMS / MacCMS provider (requires HTTP Basic admin login) |
| `POST /api/vod/import` | import providers from an authorized LibreTV/MoonTV/TVBox-compatible JSON list URL (requires HTTP Basic admin login) |
| `PATCH /api/vod/sources/:id` | rename, re-categorize, or enable/disable a VOD provider (requires HTTP Basic admin login) |
| `DELETE /api/vod/sources/:id` | remove VOD provider (requires HTTP Basic admin login) |
| `GET /api/sources` | list persistent resources (requires HTTP Basic admin login) |
| `POST /api/sources` | validate and add a persistent resource (requires HTTP Basic admin login) |
| `PATCH /api/sources/:id` | rename, change URL, or enable/disable a resource (requires HTTP Basic admin login) |
| `DELETE /api/sources/:id` | delete a resource (requires HTTP Basic admin login) |
| `GET /api/playlist.m3u?u=` | the same playlist rewritten through `/hls` |
| `GET /api/export.m3u` | current filters as a downloadable playlist (`&proxy=1` to relay) |
| `POST /api/refresh` | re-download the iptv-org API and rebuild the catalogue |
| `GET /hls?u=&r=&ua=` | HLS manifest + segment relay (see above) |
| `GET /img?u=` | channel-logo relay with a disk cache |
| `GET /api/agent/v1/openapi.json` | OpenAPI schema for agent control |
| `GET /api/agent/v1/capabilities` | capabilities, autonomy policy, source limits |
| `GET /api/agent/v1/status` | live catalog, source/provider health, automation status |
| `GET /api/agent/v1/audit?limit=50` | recent automation/agent audit events |
| `GET /api/agent/v1/project/status` | repository identity, permissions, workflows and GitHub-token readiness |
| `GET /api/agent/v1/project/tree?path=&ref=` | inspect a branch's repository tree |
| `GET /api/agent/v1/project/file?path=&ref=` | read any tracked repository file |
| `POST /api/agent/v1/project/commit` | commit multi-file edits/deletions to any branch and optionally open a PR |
| `POST /api/agent/v1/project/branch` | create a project branch |
| `POST /api/agent/v1/project/pr` | create a pull request |
| `POST /api/agent/v1/project/pr/:number/merge` | merge a pull request after validation |
| `GET /api/agent/v1/project/actions?branch=` | inspect CI/deployment runs |
| `GET /api/agent/v1/project/checks/:sha` | inspect commit checks |
| `POST /api/agent/v1/project/dispatch` | trigger a configured GitHub Actions workflow, including deployment |

| `GET /api/agent/v1/archive/search?q=&type=` | search Internet Archive public-domain/CC candidates |
| `GET /api/agent/v1/commons/search?q=&type=` | search open-license video files on Wikimedia Commons |
| `POST /api/agent/v1/tasks/run` | run `maintain_sources`, `sync_source_lists`, `check_vod_providers`, or `refresh_live_catalog` |
| `GET/POST /api/agent/v1/live/sources` | list/add live M3U resources |
| `PATCH/DELETE /api/agent/v1/live/sources/:id` | update or remove live resources |
| `GET/POST /api/agent/v1/vod/sources` | list/add VOD providers |
| `PATCH/DELETE /api/agent/v1/vod/sources/:id` | update or remove VOD providers |
| `POST /api/agent/v1/vod/import` | import a trusted provider directory by URL or JSON config |
| `GET /api/agent/v1/vod/search?type=&q=` | machine-oriented VOD + licensed-archive search |
| `GET /api/agent/v1/archive/search?type=&q=` | search the built-in Internet Archive adapter |
| `GET /healthz` | counts, timestamp, uptime |
| `GET /api/radio/stations` | search public radio directory with name, country, language, genre, codec, sorting, and paging filters |
| `GET /api/radio/options?type=` | load country, language, or genre lists |
| `GET /api/radio/resolve/:uuid` | resolve station playback through Radio Browser's click-counter endpoint |
| `GET /api/radio/stream/:ticket` | bounded audio relay using a short-lived ticket minted from a valid station UUID |
| `GET /api/portal/services` | searchable-homepage service directory; reads are public |
| `POST /api/portal/services` | add a homepage service shortcut (requires HTTP Basic admin login) |
| `PATCH /api/portal/services/:id` | update a shortcut (requires HTTP Basic admin login) |
| `DELETE /api/portal/services/:id` | remove a shortcut only (requires HTTP Basic admin login) |

All protected legacy routes use the same HTTP Basic admin login as Settings. API-token, X-Agent-Token, X-Source-Token, X-Refresh-Token and Bearer-token authentication are disabled. Use `/api/v1` for the documented common API. Mail data continues to use the Mail Workspace session.

## Agent operation and automation

See the repository-root [`AGENTS.md`](../AGENTS.md) for exact Hermes workflows and API examples. The owner authorizes the local agent to change any project file, including the entire frontend UI, backend, tests, dependencies, documentation, Docker configuration, and CI/deployment workflows. Do not impose a code-path allowlist or approval gate. Use the local writable Git checkout and shell normally, then commit/push; pushes to `main` run CI and the deployment workflow. The Basic-authenticated `/api/agent/v1/project/*` endpoints provide remote full-repository editing too. Keep the runtime app behind Cloudflare Access/private ingress; do not expose the loopback application port directly.

Configure `iptv-web/.env` from [`.env.example`](.env.example). Important settings:

- `AGENT_AUTONOMY=full`: lets the authenticated agent add, update, enable/disable, and remove providers without human clicks. Use `review` to block agent writes and import scheduled discoveries as disabled. `off` stops scheduled registry discovery.
- `AGENT_AUTOMATION_ENABLED=1`: schedules a maintenance cycle shortly after startup and every `AUTO_SOURCE_SYNC_HOURS` (default 12 hours).
- `VOD_SOURCE_LIST_URLS`: optional comma/newline-separated JSON registry URLs you explicitly trust. The job polls these directories, probes candidate APIs, adds new providers, and updates endpoints for providers previously imported from that same directory.
- The agent can trigger `maintain_sources`, `sync_source_lists`, `check_vod_providers`, and `refresh_live_catalog` through `POST /api/agent/v1/tasks/run`. Actions are recorded in `/data/agent-audit.jsonl`, readable from `GET /api/agent/v1/audit`.

Automatic discovery includes the maintained TVboxorg `dist/official.json` registry by default (`https://raw.githubusercontent.com/TVboxorg/TVbox/main/dist/official.json`), which periodically refreshes its availability-checked directory of third-party endpoints. The scheduler also polls any extra JSON registries configured in `VOD_SOURCE_LIST_URLS` or the agent settings. New endpoints are probed before activation in `full` mode; probes establish compatibility/availability, not content rights. You can replace or extend the registry URLs with `PATCH /api/agent/v1/settings`. The built-in Internet Archive and Wikimedia Commons catalogs separately discover records with declared open licenses, which should still be checked on the original item page.

VOD provider configuration is stored in `data/vod-sources.json` on the persistent volume, and agent settings are stored in `data/agent-settings.json`. The adapter
supports the common Apple CMS / MacCMS JSON API (`ac=videolist`, `wd`, `pg`, and `ids` queries) used by
LibreTV/MoonTV-style deployments. Select a provider category when adding it so movies, series, and
anime are routed to the right section. In the VOD resource manager, you can either add a single API
or import a hosted JSON configuration URL / upload a downloaded JSON file. The importer understands
LibreTV SourceList JSON (`sources`), MoonTV `config.json` (`api_site`), and compatible TVBox-style `sites` arrays. Importing adds provider
endpoints only; endpoints are not independently verified by a source list, and the importer does not
verify content licensing or streaming rights. Add only catalogs you are authorized to use.

### Local agent workspace (Hermes and other server agents)

The deployment release directory is not a Git checkout. After this version has been deployed, bootstrap a normal writable private-repository checkout on the same host:

```bash
export IPTV_DEPLOY_DIR=/path/to/the/current/deployment-directory
export IPTV_ENV_FILE="$IPTV_DEPLOY_DIR/.env"
export IPTV_WORKSPACE_DIR="$HOME/src/iptv"
bash "$IPTV_DEPLOY_DIR/tools/bootstrap-agent-workspace.sh"
cd "$IPTV_WORKSPACE_DIR"
```

The existing deployment `.env` must contain `GITHUB_REPO_TOKEN` with repository Contents, Workflows, Pull requests, and Actions read/write permissions. The helper configures Git authentication without putting the token in the remote URL or storing it in `.git-credentials`. The local agent can then read/write every file—including `iptv-web/public/index.html`, `app.js`, `app.css`, server code, tests, and `.github/workflows/*`—run shell commands, install/update dependencies, commit, push, and deploy.

Run tests and use `IPTV_ENV_FILE="$IPTV_DEPLOY_DIR/.env" bash iptv-web/tools/deploy-local.sh` for a local deployment. It identifies the existing Compose project to preserve the existing named `/data` volume, builds before replacing the running container, and checks health. Prefer a tested push to `main` when possible; the CI/deploy workflow rolls it out automatically. Full details and remote API examples are in [`AGENTS.md`](../AGENTS.md).

## Layout

```
server.js            router wiring, startup refresh logic
lib/util.js          mime map, gzip responses, SSRF guard, normalisation
lib/router.js        tiny :param router
lib/fetch-upstream.js outbound fetch with redirect + SSRF checks per hop
lib/hls.js           manifest rewriting + segment relay
lib/img.js           logo relay + disk LRU cache
lib/catalog.js       in-memory catalogue, filtering, ranked search
lib/refresh.js       download iptv-org API -> data/catalog.json (+ meta.json, .gz)
lib/sources.js        persistent M3U source registry and catalogue merger
lib/vod.js            Apple CMS / MacCMS provider adapter + provider-list importer
lib/archive-vod.js     Internet Archive public-domain / CC movie adapter
lib/commons-vod.js     Wikimedia Commons open-license video adapter
lib/agent-settings.js persistent runtime settings that agents can update
lib/registry-lock.js   serialized registry writes across agent/refresh operations
lib/automation.js     scheduled provider discovery, health checks, and audit
lib/agent.js          Shared admin-authenticated agent API, OpenAPI schema and settings
tools/agentctl.js     dependency-free CLI for Hermes and other agents
lib/m3u.js           M3U parser (server); public/js/m3u.js is the browser twin
lib/static.js        static serving with etag + gzip
public/              index.html (portal), watch.html (IPTV), radio.html/css/js (radio), portal.css/js, app.css/js, js/i18n.js, vendor/hls.min.js
lib/radio.js          Radio Browser mirror discovery, cached search, secure URL resolution, bounded audio relay
tools/probe.js       stream-health sampler: node tools/probe.js 40 all
deploy/              scripts used to stand the site up on the server
```

## Hermes / agent CLI

The dependency-free `tools/agentctl.js` CLI wraps the authenticated agent API and returns JSON for automation. Set `IPTV_BASE_URL`, `IPTV_ADMIN_USERNAME` and `IPTV_ADMIN_PASSWORD` in your Hermes service environment; token-based API authentication is disabled. For a **local agent on the deployment server**, see [`AGENTS.md`](AGENTS.md): give its OS account write access to the real project checkout plus the privileges needed to run tests, rebuild Docker, and deploy. Local filesystem editing—including all UI files—does not require `GITHUB_REPO_TOKEN`; that secret is only needed for remote GitHub operations through the HTTP API.

```bash
node iptv-web/tools/agentctl.js capabilities
node iptv-web/tools/agentctl.js status
node iptv-web/tools/agentctl.js settings
node iptv-web/tools/agentctl.js task maintain_sources
node iptv-web/tools/agentctl.js vod-search anime cyberpunk
node iptv-web/tools/agentctl.js archive-search public domain comedy
node iptv-web/tools/agentctl.js commons-search open license animation
node iptv-web/tools/agentctl.js settings-patch '{"sourceListUrls":["https://registry.example/sources.json"],"autoSourceSyncHours":12,"autonomy":"full"}'
node iptv-web/tools/agentctl.js project-status
node iptv-web/tools/agentctl.js project-tree iptv-web/lib main
node iptv-web/tools/agentctl.js project-file iptv-web/server.js main
node iptv-web/tools/agentctl.js project-commit changes.json
node iptv-web/tools/agentctl.js project-actions main 10
```

The HTTP agent API can manage live/VOD providers and recurring maintenance. For local execution, see [`AGENTS.md`](AGENTS.md) in this packaged directory; it gives the local agent full project/file/UI authority and the test/build/deploy workflow. The root [`AGENTS.md`](../AGENTS.md) contains the broader project policy.

## Running it

Local:

```bash
node lib/refresh.js --src=data-src   # or without --src to download from iptv-org
PORT=3920 node server.js
# http://127.0.0.1:3920       (service portal)
# http://127.0.0.1:3920/watch.html (IPTV player)
# http://127.0.0.1:3920/radio.html (public radio)
```

Docker (what the server runs):

```bash
docker compose up -d --build     # 127.0.0.1:3920, catalogue in the iptv-data volume
docker compose logs -f iptv-web
```

The image bakes in a catalogue snapshot and the entrypoint seeds it into the volume, so the
first start is instant; `REFRESH_HOURS=12` triggers a background re-download when the data
goes stale, and a systemd timer (`iptv-refresh.timer`, 04:10 daily) POSTs `/api/refresh`.

## Data source

Channel/stream/logo metadata comes from the [iptv-org API](https://github.com/iptv-org/api)
(`https://iptv-org.github.io/api/`), which is generated from the
[iptv-org/iptv](https://github.com/iptv-org/iptv) project (CC0 / MIT for the metadata).
`lib/refresh.js` tries iptv-org directly and falls back to GitHub raw proxies so a refresh
also works from networks where GitHub Pages is unreachable.

**This app usually hosts no video.** Live streams and configured VOD providers are third-party endpoints; the relay forwards bytes on demand. Internet Archive content is streamed from Archive.org and shown only when its metadata declares public-domain or supported CC licensing. Metadata labels can be wrong or incomplete; users must check the underlying record and local rules. Provider directories (including LibreTV/MoonTV/TVBox-style config) do not, by themselves, grant rights to the videos they point to.


## Mail Workspace

Open /mail.html to use the web email client. It reuses the existing Mailcow host mail.nafisainternational.com; it does not provision mailboxes. The eight supplied accounts are prelisted with @mail.nafisainternational.com identities and the admin role aliases.

Configure these values in the deployment environment and rebuild/restart: EMAIL_WORKSPACE_PASSWORD (separate web login password), EMAIL_SESSION_SECRET (random session HMAC key, at least 32 characters), EMAIL_CREDENTIALS_KEY (exactly 64 hex characters from openssl rand -hex 32), EMAIL_ALLOWED_MAIL_HOSTS=mail.nafisainternational.com, MAIL_COOKIE_SECURE=1 for HTTPS, and EMAIL_AGENT_SEND_MODE=approval by default. Losing the encryption key means mailbox credentials must be entered again.

Mailbox credentials are encrypted at rest with AES-256-GCM in /data/mail-workspace.json and never returned by APIs. Enter mailbox passwords in the authenticated HTTPS settings page; do not embed them in source control, prompts, logs or browser local storage. Use a unique workspace password. Rotate any shared mailbox password exposed outside its intended context.

Features: IMAP TLS 993, SMTP STARTTLS 587 or TLS 465, folder/message view, compose and send, alias-aware From addresses, drafts, address-book CRUD and audit events. Message HTML is not executed; attachments are listed but not downloaded in this initial UI.

Agents use the same HTTP Basic admin login with GET /api/agent/v1/mail/openapi.json, /accounts, /folders, /messages, /message, /contacts and /drafts plus POST /drafts and /drafts/:id/send. Agent-created drafts require owner approval by default. Set EMAIL_AGENT_SEND_MODE=direct only if trusted agents should send unattended. Allowed mail hosts are restricted by EMAIL_ALLOWED_MAIL_HOSTS.

CI passing does not prove the live VPS has these environment values, that SMTP/IMAP connections work, or that this change is deployed.
