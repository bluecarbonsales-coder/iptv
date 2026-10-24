# IPTV Web

A self-hosted web player for the [iptv-org](https://github.com/iptv-org/iptv) catalogue:
browse ~10,000 live channels, filter by country/category/quality, search, favourite, and
watch them in the browser — plus load **any** M3U playlist (URL or local file) and watch
that too.

Live deployment: **https://iptv.nafisainternational.com**

```
┌────────────┐   https   ┌──────────────┐   loopback  ┌────────────────────┐
│  browser   │ ────────► │  openresty   │ ──────────► │  node (this app)   │
│  hls.js    │ ◄──────── │  (host vhost)│ ◄────────── │  catalog + relay   │
└────────────┘   /hls    └──────────────┘             └─────────┬──────────┘
                                                                │ plain http/https
                                                                ▼
                                                     third-party IPTV origins
```

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
- **No dependencies** — plain Node stdlib, no npm install, no build step.

## API

| Route | Purpose |
|---|---|
| `GET /api/meta` | countries / categories / qualities with counts, catalogue timestamp |
| `GET /api/channels` | `q`, `country`, `category`, `minQuality`, `hasLogo`, `nsfw`, `ids`, `sort`, `page`, `limit` |
| `GET /api/channel/:id` | one channel with every stream URL, quality, referrer, user-agent, labels |
| `GET /api/playlist?u=` | import an external M3U (server-side fetch + parse) |
| `GET /api/vod?type=&q=` | search configured VOD APIs and the built-in Internet Archive adapter for `all`, `movies`, `series`, or `anime` (includes Internet Archive and Wikimedia Commons results) |
| `GET /api/vod/:sourceId/:vodId` | resolve details and episodes for a VOD title |
| `GET /api/vod/sources` | list VOD providers (requires `X-Source-Token`) |
| `POST /api/vod/sources` | validate and add Apple CMS / MacCMS provider (requires `X-Source-Token`) |
| `POST /api/vod/import` | import providers from an authorized LibreTV/MoonTV/TVBox-compatible JSON list URL (requires `X-Source-Token`) |
| `PATCH /api/vod/sources/:id` | rename, re-categorize, or enable/disable a VOD provider (requires `X-Source-Token`) |
| `DELETE /api/vod/sources/:id` | remove VOD provider (requires `X-Source-Token`) |
| `GET /api/sources` | list persistent resources (requires `X-Source-Token`) |
| `POST /api/sources` | validate and add a persistent resource (requires `X-Source-Token`) |
| `PATCH /api/sources/:id` | rename, change URL, or enable/disable a resource (requires `X-Source-Token`) |
| `DELETE /api/sources/:id` | delete a resource (requires `X-Source-Token`) |
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

`POST /api/refresh` is accepted from the host itself without a token; anything arriving
through the reverse proxy must send `X-Refresh-Token` matching `REFRESH_TOKEN`. Resource-management
requests require `X-Source-Token`, matching `SOURCE_TOKEN` or (if unset) `REFRESH_TOKEN`.
Enter that token in the Resource manager panel; it is held in the current browser tab only.
Configure a strong random token in the deployment environment before exposing the UI publicly.

## Agent operation and automation

See the repository-root [`AGENTS.md`](../AGENTS.md) for exact Hermes workflows and API examples. The agent API requires a long random `AGENT_API_TOKEN` sent as `X-Agent-Token` or a Bearer token. It is disabled when the token is unset. Authenticated agents can manage source lists and operational settings without human approval; for full code edits, Hermes should use its normal repository/workspace tools. Keep the service behind Cloudflare Access/private ingress; do not expose the loopback application port directly.

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
lib/agent.js          Hermes/agent API, OpenAPI schema, token auth and agent settings
tools/agentctl.js     dependency-free CLI for Hermes and other agents
lib/m3u.js           M3U parser (server); public/js/m3u.js is the browser twin
lib/static.js        static serving with etag + gzip
public/              index.html, app.css, app.js, js/i18n.js, vendor/hls.min.js
tools/probe.js       stream-health sampler: node tools/probe.js 40 all
deploy/              scripts used to stand the site up on the server
```

## Hermes / agent CLI

The dependency-free `tools/agentctl.js` CLI wraps the authenticated agent API and returns JSON for automation. Set `IPTV_BASE_URL` and `AGENT_API_TOKEN` in your Hermes service environment; do not store the token in the repository or a prompt. For a **local agent on the deployment server**, see [`AGENTS.md`](AGENTS.md): it grants the local agent full project/file/UI editing authority and documents the deployment path. A local checkout and shell access do not require a `GITHUB_REPO_TOKEN`; that server-side token is only for remote GitHub operations via the HTTP API. For a **local agent on the deployment server**, see [`AGENTS.md`](AGENTS.md): give the agent's OS account write access to the real checkout and the privileges needed for tests, Docker rebuilds and deployment. Local editing of the repository and UI does not require `GITHUB_REPO_TOKEN`; that server-side token is only for remote GitHub operations through the HTTP API.

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
# http://127.0.0.1:3920
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
