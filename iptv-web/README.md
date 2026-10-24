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
| `GET /api/vod?type=&q=` | search configured VOD APIs for `all`, `movies`, `series`, or `anime` |
| `GET /api/vod/:sourceId/:vodId` | resolve details and episodes for a VOD title |
| `GET /api/vod/sources` | list VOD providers (requires `X-Source-Token`) |
| `POST /api/vod/sources` | validate and add Apple CMS / MacCMS provider (requires `X-Source-Token`) |
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
| `GET /healthz` | counts, timestamp, uptime |

`POST /api/refresh` is accepted from the host itself without a token; anything arriving
through the reverse proxy must send `X-Refresh-Token` matching `REFRESH_TOKEN`. Resource-management
requests require `X-Source-Token`, matching `SOURCE_TOKEN` or (if unset) `REFRESH_TOKEN`.
Enter that token in the Resource manager panel; it is held in the current browser tab only.
Configure a strong random token in the deployment environment before exposing the UI publicly.

VOD provider configuration is stored in `data/vod-sources.json` on the persistent volume. The adapter
supports the common Apple CMS / MacCMS JSON API (`ac=videolist`, `wd`, `pg`, and `ids` queries) used by
LibreTV/MoonTV-style deployments. Select a provider category when adding it so movies, series, and
anime are routed to the right section. No third-party movie endpoints or source lists are bundled;
add only services you are authorized to use and verify the licensing/streaming rights of their content.

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
lib/vod.js            Apple CMS / MacCMS VOD provider adapter
lib/m3u.js           M3U parser (server); public/js/m3u.js is the browser twin
lib/static.js        static serving with etag + gzip
public/              index.html, app.css, app.js, js/i18n.js, vendor/hls.min.js
tools/probe.js       stream-health sampler: node tools/probe.js 40 all
deploy/              scripts used to stand the site up on the server
```

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

**This app hosts no video.** Every stream is a third-party URL listed by iptv-org; the relay
only forwards bytes on demand. Availability, legality and geo-restrictions are the origin
broadcaster's business — many listed streams are unofficial re-broadcasts and some
jurisdictions restrict watching them. Use accordingly.
