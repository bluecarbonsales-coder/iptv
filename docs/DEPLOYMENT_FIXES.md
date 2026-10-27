# Deployment fixes carried by this project

Records the fixes this deployment carries on top of upstream `main`, why each exists, and how to
verify it is still intact after a merge. Most of them came from observing production, not from a
review: each entry names the symptom that exposed it, so a regression is recognisable.

Several entries are enforced automatically by the deployment guard (canary on a copy of live data +
invariant gate + image-ID check) before any swap, so a merge that silently drops one aborts the
deploy instead of shipping.

## Playback and availability

### 1. A locked response body must not be cancelled blindly

**Symptom:** a 404 from a stream origin restarted the container and dropped every viewer
(`ReadableStream is locked` in the log, `RestartCount` > 0, full catalogue reload on boot). Docker's
`unless-stopped` policy hid it by restarting in about a second.

`response.body.cancel()` is only safe on a body nobody has read. Cancelling an already-consumed
stream rejects with `ERR_INVALID_STATE`, and Node terminates on an unhandled rejection. The relay
read the body and then cancelled it.

**Fix:** the awaited `cancelBody()` in `lib/fetch-upstream.js`, used by `lib/hls.js`, `lib/img.js`
and `lib/transcode.js`. Never the fire-and-forget `body && body.cancel()` inside a sync `try`.

**Verify:** `grep -c cancelBody lib/fetch-upstream.js lib/hls.js` is non-zero and
`docker inspect <container> --format '{{.RestartCount}}'` stays at 0 while a dead upstream 404s.

### 2. A throwing route handler must not take the process down

`lib/router.js` wraps handler dispatch in try/catch: it logs `route handler failed:`, answers 500
(half-finished responses are ended), and leaves the process serving.

### 3. Process-level guards

`server.js` installs `unhandledRejection` / `uncaughtException` handlers that log instead of
exiting. This is a deliberate choice of availability over strictness for a long-running relay.

## 4. Browser caching (why a deploy can look like it did nothing)

**Symptom:** a fix was live on the server while the browser kept replaying the broken file for a day
and the deploy looked failed.

`lib/static.js` sent `Cache-Control: public, max-age=86400` for everything under `public/`. Now
html/js/css/json revalidate (`no-cache`; the ETag still answers 304) while images, fonts and
vendored bundles keep the long cache, and `stampAssets()` rewrites root-absolute `js`/`css`
references in served HTML with the asset's mtime (`/app.js?v=1793075911000`) so a URL a browser
already holds changes.

**Verify:** `curl -sI <base>/app.js | grep -i cache-control` says `no-cache`, and a page's HTML
carries `src="/app.js?v=<digits>"`. After changing only an asset, `touch public/*.html` before the
build, otherwise the served HTML is unchanged and browsers keep the old, unstamped markup.

## 5. Open-license (archive.org) catalogue

**Contract:** the `vodId` of an archive record is the **bare archive.org identifier**. The Theatre
requests `/api/vod/archive/<vodId>`, resolved by `archiveLib.getDetail(<id>)`. `catalogueItem()`
already namespaces the stored record as `vod-archive-<id>`, so `archiveItem()` and the live-search
archive block must pass the id unchanged — a second `archive-` prefix makes every open-license title
404 on playback (symptom: the tile lists fine, the detail request answers *Archive item is not a
movie/video entry*).

**Legacy repair:** records written by the buggy builds are fixed at boot by
`repairLegacyArchiveIds(dataDir)`, which prunes `sourceId === 'archive' && vodId.startsWith('archive-')`
and immediately re-harvests the open-license collections. The re-harvest is the point: the boot kick
alone is a no-op while the index is younger than the refresh interval, so a prune-only repair leaves
titles missing for up to an hour.

**Cold index:** a freshly built volume is served by `vodSearchLegacy` instead of an empty Theatre,
while the index is built in the background (`lib/api.js` → `vodSearch`).

## 6. Theatre catalogue at scale

An index-backed catalogue (`lib/vod-catalog.js`) plus a re-architected `/api/vod` (the previous
implementation is kept as `vodSearchLegacy` and still serves the cold-index path). `server.js`
exposes `/api/vod/catalog` and `/api/v1/iptv/catalog` (+ `/api/v1/iptv/catalog/refresh`) and kicks
`ensureFresh()` at boot. `public/movies.html` pages on the server (`pageSize: 24`, `pages`,
`catalogTotal`, `catalogAt`) instead of loading the whole library into the browser; the response
carries the provider health it was built from.

## 7. The IPTV tab (`watch.html`)

Three defects all presented as "the channel list is empty":

- **`$` is `querySelector`, `$$` is `querySelectorAll`.** `$('.tab').forEach(...)` threw
  `TypeError: ... is not a function`, the rest of the init never ran, and the grid stayed on its
  placeholder while `/api/channels` answered 200 the whole time. **Read the browser's first console
  error before debugging the API** - the API was innocent.
- **Languages moved out of `channels.json`** into `feeds.json` (`{channel, id, name, languages[]}`).
  `lib/refresh.js#build` now unions a channel's feeds, then the channel row, then the country's
  official languages. Without it every channel is built with `languages: []` and the language select
  has no options.
- **`lib/sources.js#mergeInto` rebuilt `meta` from scratch** and dropped the language vocabulary, so
  the facet vanished again on the next refresh even from a good index. `buildLanguageFacet()`
  preserves it and only counts are recomputed.

**Invariant to keep:** every channel record carries a `languages` array. `server.js` treats one
missing array as "language index missing" and re-refreshes the whole catalogue.

**Renewal** is no longer boot-only: `kickCatalogue()` runs at boot and every
`CATALOG_CHECK_MINUTES` (default 30), refreshing only when the catalogue is missing, missing its
language index, or older than `REFRESH_HOURS`. `refreshNow()` is single-flight.

## 8. Verified provider and playlist additions

Registry screening matters more than endpoint count: **metadata is not playback.**

- **VOD providers, 33 → 37.** Each new provider was probed, its titles actually read (popular
  *资源站* endpoints are frequently adult-content sites), and a title played end to end through the
  relay. 泽卡资源 and 极速云资源 were rejected on that basis (episode hosts do not resolve / they
  return a player page instead of a stream), 金鹰资源 was repointed at `jyzyapi.com` after its old
  host stopped resolving, and 无尽资源 was moved to the fastest of its interchangeable siblings
  (`api.wujinapi.me`; `.net`/`.cc` serve the same catalogue).
- **Live-TV playlists, 4 → 7.** Every list is measured before it is kept: sample ~12 channels
  through the relay and classify the bodies (`#EXTM3U` / `ftyp` / `FLV` / an error). The additions
  score 8/12, 9/12 and 4/12 against incumbents at 0-3/12. Reachability *from the server* is what
  counts, because every stream is relayed server-side.

Notes that save a future session time: the VOD registry seed (`lib/default-vod-sources.js`) is only
applied when no registry file exists, so an existing deployment keeps its own
`/data/vod-sources.json`; the playlist seeds in `data/community-playlist-sources.json` are
merge-by-URL at start, so adding one needs an image rebuild, and deleting a seed does **not** remove
the row from a live deployment. The movie index only ever upserts, so a removed provider's rows stay
until they are pruned explicitly.

## 9. Deploy discipline

- `stop` + `up -d` does **not** deploy a rebuilt image: for a stopped container compose only starts
  it and never compares the image, so a rebuild under the same tag leaves the old code serving while
  the deploy looks successful. Always `up -d --no-build --force-recreate`.
- Compare image IDs in the same form (`docker inspect <image> --format '{{.Id}}'` on both sides); a
  container's `.Image` is `sha256:<64>` while `docker images --format '{{.ID}}'` is 12 chars.
- `test/` is not shipped in the image; run the suite in a throwaway `node:22-alpine` container
  against the checkout, since the host node version may differ from the image's.
- The previous image is tagged `rollback-<ts>` and the data volume is backed up before the swap, so
  a failed verification is a one-command rollback.
