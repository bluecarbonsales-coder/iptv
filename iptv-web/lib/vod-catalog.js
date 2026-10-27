'use strict';
// VOD catalogue engine.
//
// The portal's Theatre catalogue used to be whatever a single page-1 query per
// provider happened to return, which collapses to a few dozen titles. This module
// harvests each Apple CMS / MacCMS provider properly:
//
//   * reads the provider's own category tree (ac=list → class[]) so movie, series,
//     anime and documentary queries use the provider's type ids instead of hoping a
//     mixed "latest" list contains the right kind;
//   * walks several pages per provider (pg=1..N) instead of page 1 only;
//   * records response time, availability, title counts and the failure reason for
//     every provider, persisted to DATA_DIR/vod-provider-health.json;
//   * adds the open-license Internet Archive collections (paged, several
//     collections) alongside the providers;
//   * persists everything as searchable metadata in DATA_DIR/media-library.json and
//     serves the UI from that index, so browsing thousands of titles never fans out
//     to the providers again.
//
// Playback URLs are deliberately NOT stored here: they are resolved on demand by
// lib/vod.getDetail() via /api/vod/:sourceId/:vodId.
const fs = require('fs');
const path = require('path');
const vodLib = require('./vod');
const archiveLib = require('./archive-vod');
const mediaLibrary = require('./media-library');

function intEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

// Depth of one catalogue pass: 4 pages x 60 titles per provider is ~240 titles per
// source per refresh (~8k with the shipped provider list) in roughly half a minute
// of background work, and stays inside what these APIs tolerate.
const PROVIDER_PAGES = intEnv('VOD_CATALOG_PAGES', 4, 1, 25);
const PROVIDER_PAGE_LIMIT = intEnv('VOD_CATALOG_PAGE_LIMIT', 60, 5, 200);
const CONCURRENCY = intEnv('VOD_CATALOG_CONCURRENCY', 6, 1, 16);
const REFRESH_MINUTES = intEnv('VOD_CATALOG_REFRESH_MINUTES', 60, 5, 1440);
const FRESH_PAGES = intEnv('VOD_CATALOG_FRESH_PAGES', 2, 0, 5);
const ARCHIVE_PAGES = intEnv('VOD_CATALOG_ARCHIVE_PAGES', 3, 0, 8);
const ARCHIVE_ROWS = intEnv('VOD_CATALOG_ARCHIVE_ROWS', 100, 10, 100);
const TIMEOUT_MS = intEnv('VOD_CATALOG_TIMEOUT_MS', 20000, 3000, 60000);
const MAX_ITEMS_PER_SOURCE = intEnv('VOD_CATALOG_MAX_ITEMS_PER_SOURCE', 4000, 20, 60000);
const MAX_TYPE_IDS = intEnv('VOD_CATALOG_MAX_TYPE_IDS', 6, 1, 20);
const BROWSE_KINDS = ['movies', 'series', 'anime', 'documentary'];
const KIND_DEFAULT_LIMIT = intEnv('VOD_CATALOG_PAGE_SIZE', 24, 1, 120);

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { result[index] = { status: 'fulfilled', value: await fn(items[index], index) }; }
      catch (reason) { result[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return result;
}

function healthPath(dataDir) { return path.join(dataDir, 'vod-provider-health.json'); }
function readHealth(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(healthPath(dataDir), 'utf8'));
    return { version: 1, updatedAt: raw.updatedAt || null, durationMs: raw.durationMs || null, archive: raw.archive || null, totals: raw.totals || null, providers: Array.isArray(raw.providers) ? raw.providers : [] };
  } catch { return { version: 1, updatedAt: null, durationMs: null, archive: null, totals: null, providers: [] }; }
}
function writeHealth(dataDir, value) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = healthPath(dataDir);
  const temp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, ...value }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}

// ---------------------------------------------------------------- provider tree

async function categoryTree(source) {
  const started = Date.now();
  const ids = Object.create(null);
  const names = Object.create(null);
  for (const action of ['list', 'class']) {
    try {
      const payload = await vodLib.fetchJson(vodLib.apiQuery(source, { ac: action }), TIMEOUT_MS);
      vodLib.providerStatus(payload);
      const classes = [payload && payload.class, payload && payload.data && payload.data.class].find(Array.isArray);
      if (!classes || !classes.length) continue;
      for (const entry of classes) {
        const id = String((entry && (entry.type_id ?? entry.typeId ?? entry.id)) ?? '').trim();
        const name = String((entry && (entry.type_name ?? entry.typeName ?? entry.name)) ?? '').trim();
        if (!id || !/^\d+$/.test(id)) continue;
        names[id] = name;
        const kind = vodLib.classify({ type_name: name, category: name });
        if (!ids[kind]) ids[kind] = [];
        if (ids[kind].length < MAX_TYPE_IDS) ids[kind].push(id);
      }
      if (Object.keys(names).length) return { ok: true, ms: Date.now() - started, action, ids, names };
    } catch (error) {
      if (action === 'class') return { ok: false, ms: Date.now() - started, ids, names, error: String(error && error.message || error).slice(0, 180) };
    }
  }
  return { ok: false, ms: Date.now() - started, ids, names, error: 'provider did not return a category tree' };
}

function typeIdsFor(tree, kind) {
  if (!tree || !tree.ids) return [];
  if (kind === 'all') {
    const all = [];
    for (const value of Object.values(tree.ids)) for (const id of value) if (!all.includes(id)) all.push(id);
    return all.slice(0, MAX_TYPE_IDS * 2);
  }
  return (tree.ids[kind] || []).slice(0, MAX_TYPE_IDS);
}

// ------------------------------------------------------------------- harvesting

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function harvestSource(source, options = {}) {
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : ['movies'];
  const pages = Math.max(1, options.pages || PROVIDER_PAGES);
  const freshPages = Math.max(0, Math.min(5, options.freshPages ?? FRESH_PAGES));
  const startPage = Math.max(1, options.startPage || 1);
  const started = Date.now();
  const items = [];
  const seen = new Set();
  let requests = 0, received = 0, lastError = null, pageCount = null, total = null;
  const kindCounts = Object.create(null);
  const tree = await categoryTree(source);
  const wanted = new Set();
  for (const kind of kinds) for (const id of typeIdsFor(tree, kind)) wanted.add(id);
  const typeList = [...wanted];
  const action = vodLib.preferredListAction(source);

  function addRows(rows) {
    received += rows.length;
    for (const row of rows) {
      const item = vodLib.normalizeItem(row, source);
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      kindCounts[item.kind] = (kindCounts[item.kind] || 0) + 1;
      items.push(item);
    }
  }
  async function fetchPage(page, extra) {
    const attempts = [];
    // Most deployments ignore "t" (their API answers 0 rows for an unsupported
    // filter), but the providers that do honour it save a lot of pages.
    if (typeList.length) attempts.push({ ac: action, t: typeList.join(','), pg: String(page) });
    attempts.push({ ac: action, pg: String(page) });
    for (const attempt of attempts) {
      const query = extra ? { ...attempt, ...extra } : attempt;
      try {
        requests += 1;
        const payload = await vodLib.fetchJson(vodLib.apiQuery(source, query), TIMEOUT_MS);
        vodLib.providerStatus(payload);
        const list = vodLib.listFrom(payload);
        if (payload) {
          pageCount = positiveInt(payload.pagecount ?? payload.page_count ?? payload.pages) || pageCount;
          total = positiveInt(payload.total) || total;
        }
        if (!list.length && attempt.t) continue;
        return list;
      } catch (error) { lastError = error; }
    }
    return [];
  }

  // Pass 1: titles updated in the last day (h=24) — keeps new releases immediate.
  for (let page = 1; page <= freshPages; page += 1) {
    const rows = await fetchPage(page, { h: '24' });
    if (!rows.length) break;
    addRows(rows);
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
  }
  // Pass 2: the rotating deep window. Providers here expose 20 titles per page and
  // thousands of pages (total counts run to ~10^5), so each refresh walks on from
  // where the previous one stopped and the persisted index covers more over time.
  for (let page = startPage; page < startPage + pages; page += 1) {
    const rows = await fetchPage(page);
    if (!rows.length) break;
    addRows(rows);
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
  }

  const nextPage = pageCount && startPage + pages <= pageCount ? startPage + pages : 1;
  const ms = Date.now() - started;
  const ok = items.length > 0;
  return {
    source,
    ok,
    ms,
    tree,
    requests,
    received,
    kindCounts,
    items,
    pageCount,
    total,
    windowStart: startPage,
    nextPage,
    error: ok ? null : String((lastError && lastError.message) || tree.error || 'provider returned no titles').slice(0, 180),
  };
}

function catalogueItem(item, kind) {
  return {
    id: 'vod-' + item.sourceId + '-' + item.id,
    vod: true,
    vodId: item.id,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    name: item.name,
    logo: item.logo || null,
    overview: item.overview || '',
    cats: [item.category || kind || 'VOD'],
    category: item.category || '',
    year: item.year || '',
    remarks: item.remarks || '',
    kind: item.kind || kind || 'movies',
    pageUrl: item.pageUrl || null,
    licenseUrl: item.licenseUrl || null,
  };
}

function flattenHarvest(results, kinds) {
  const byKey = new Map();
  for (const result of results) {
    if (!result || result.status !== 'fulfilled') continue;
    for (const item of result.value.items) {
      if (kinds.length && !kinds.includes(item.kind)) continue;
      const key = item.key;
      const prior = byKey.get(key);
      if (!prior) { byKey.set(key, item); continue; }
      // keep the richer record when two harvest passes see the same title
      const score = (x) => (x.logo ? 4 : 0) + (x.overview ? 2 : 0) + (x.year ? 1 : 0);
      if (score(item) > score(prior)) byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

// ------------------------------------------------------------- metadata artwork
// Rich movie metadata (poster, overview, genres, release year) for harvested titles
// that arrived without artwork. TMDB is the documented provider and is used whenever
// TMDB_API_KEY is configured; TVmaze needs no key and covers the series/anime side,
// so the catalogue still gains artwork on a stock install. These services supply
// metadata only — they are never treated as a playback source.
const METADATA_ENRICH_LIMIT = intEnv('VOD_METADATA_ENRICH_LIMIT', 25, 0, 200);
const TMDB_KEY = String(process.env.TMDB_API_KEY || '').trim();
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';

async function metadataLookup(item) {
  const isSeries = ['series', 'anime'].includes(item.kind);
  const errors = [];
  if (TMDB_KEY) {
    try {
      const url = new URL('https://api.themoviedb.org/3/search/' + (isSeries ? 'tv' : 'movie'));
      url.searchParams.set('api_key', TMDB_KEY);
      url.searchParams.set('query', item.name);
      url.searchParams.set('include_adult', 'false');
      if (/^\d{4}$/.test(String(item.year || ''))) url.searchParams.set(isSeries ? 'first_air_date_year' : 'year', item.year);
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error('TMDB HTTP ' + response.status);
      const data = await response.json();
      const hit = (data.results || [])[0];
      if (hit) {
        const date = String(hit.release_date || hit.first_air_date || '');
        return {
          logo: hit.poster_path ? TMDB_IMAGE + hit.poster_path : null,
          overview: hit.overview || '',
          year: item.year || date.slice(0, 4),
          category: item.category || (Array.isArray(hit.genre_ids) && hit.genre_ids.length ? item.category : ''),
          tmdbId: hit.id,
          metadataSource: 'tmdb',
          errors,
        };
      }
    } catch (error) { errors.push('tmdb: ' + String(error && error.message || error).slice(0, 90)); }
  }
  if (isSeries) {
    try {
      const url = new URL('https://api.tvmaze.com/search/shows');
      url.searchParams.set('q', item.name);
      const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      if (!response.ok) throw new Error('TVmaze HTTP ' + response.status);
      const data = await response.json();
      const show = Array.isArray(data) && data.length ? (data[0].show || {}) : null;
      if (show) {
        return {
          logo: (show.image && (show.image.medium || show.image.original)) || null,
          overview: String(show.summary || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200),
          year: item.year || String(show.premiered || '').slice(0, 4),
          category: item.category || (Array.isArray(show.genres) ? show.genres.join(' / ') : ''),
          tvmazeId: show.id,
          metadataSource: 'tvmaze',
          errors,
        };
      }
    } catch (error) { errors.push('tvmaze: ' + String(error && error.message || error).slice(0, 90)); }
  }
  return null;
}

async function enrichMetadata(dataDir, items, options = {}) {
  const limit = options.limit === undefined ? METADATA_ENRICH_LIMIT : Math.max(0, Math.min(200, options.limit));
  const report = { enabled: Boolean(TMDB_KEY) || limit > 0, tmdbConfigured: Boolean(TMDB_KEY), attempted: 0, enriched: 0, providers: {}, errors: [] };
  if (!limit) return report;
  const targets = items.filter((item) => !item.logo && !/^[\W\d_]+$/.test(String(item.name || ''))).slice(0, limit);
  if (!targets.length) return report;
  report.attempted = targets.length;
  const updated = [];
  const results = await mapLimit(targets, 3, async (item) => {
    const found = await metadataLookup(item);
    if (!found) return null;
    return { ...item, ...found, errors: undefined };
  });
  for (const result of results) {
    if (!result || result.status !== 'fulfilled' || !result.value) continue;
    const value = result.value;
    report.enriched += 1;
    report.providers[value.metadataSource] = (report.providers[value.metadataSource] || 0) + 1;
    for (const error of value.errors || []) if (!report.errors.includes(error)) report.errors.push(error);
    updated.push(value);
  }
  if (updated.length) {
    try { mediaLibrary.upsert(dataDir, updated.map((item) => catalogueItem(item, item.kind))); } catch { /* best effort */ }
  }
  return report;
}

function archiveItem(item) {
  // The *bare* archive.org identifier is the id the player needs: /api/vod/archive/<id>
  // resolves through archiveLib.getDetail(<id>). catalogueItem() already namespaces the
  // stored record as 'vod-archive-<id>'; adding a second prefix here made every
  // open-license title unplayable (the Theatre asked for
  // /api/vod/archive/archive-<id>, which archive.org does not have).
  return catalogueItem({
    id: item.id,
    sourceId: 'archive',
    sourceName: item.sourceName || 'Internet Archive (open-license)',
    name: item.name,
    logo: item.logo,
    overview: item.overview,
    category: item.category,
    year: item.year,
    remarks: item.remarks,
    kind: item.kind,
    pageUrl: item.pageUrl,
    licenseUrl: item.licenseUrl,
  }, item.kind);
}

// Repair for records written by the builds that doubled the archive id prefix
// ('archive-…' inside the 'vod-archive-…' record builder): their vodId pointed at an
// archive.org identifier that does not exist, so those titles 404'd on playback. The
// prune below drops them and the harvest re-adds the same titles with the bare
// identifier. Idempotent — a no-op once the index is clean.
function pruneLegacyArchiveIds(dataDir) {
  return mediaLibrary.prune(dataDir, (item) => item && item.sourceId === 'archive' && String(item.vodId || '').startsWith('archive-'));
}

// Boot-time repair: drop the malformed records *and* immediately re-harvest the open-license
// collections (a few seconds, no provider calls) so the repaired titles are back before the
// first page load instead of waiting for the next full harvest window.
async function repairLegacyArchiveIds(dataDir) {
  const removed = pruneLegacyArchiveIds(dataDir);
  if (!removed || ARCHIVE_PAGES <= 0) return { removed, restored: 0, stored: null };
  const found = await archiveLib.harvest({ pages: ARCHIVE_PAGES, rows: ARCHIVE_ROWS, kinds: BROWSE_KINDS });
  const stored = found.length ? mediaLibrary.upsert(dataDir, found.map(archiveItem)) : null;
  return { removed, restored: found.length, stored: stored && stored.total || 0 };
}

async function refreshCatalogue(options = {}) {
  const dataDir = options.dataDir;
  const started = Date.now();
  const legacyArchiveIds = pruneLegacyArchiveIds(dataDir);
  const registry = vodLib.loadSourcesSync(dataDir);
  const sources = (options.sources || registry.sources || []).filter((source) => source.enabled !== false);
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : BROWSE_KINDS;
  const pages = Math.max(1, options.pages || PROVIDER_PAGES);

  // Each provider keeps a rotating page cursor in the health file, so successive
  // refreshes walk deeper into the provider catalogue instead of re-reading page 1.
  const priorById = new Map((readHealth(dataDir).providers || []).map((row) => [row.id, row]));
  const results = await mapLimit(sources, Math.max(1, options.concurrency || CONCURRENCY), (source) => {
    const previous = priorById.get(source.id) || {};
    return harvestSource(source, {
      kinds,
      pages,
      startPage: positiveInt(previous.nextPage) || 1,
      freshPages: options.freshPages,
    }).catch((error) => ({
      source, ok: false, ms: null, tree: null, requests: 0, received: 0, kindCounts: {}, items: [],
      pageCount: previous.pageCount || null, total: previous.catalogueTotal || null, nextPage: previous.nextPage || 1,
      error: String(error && error.message || error).slice(0, 180),
    }));
  });

  const harvested = flattenHarvest(results, kinds);
  let stored = null;
  if (harvested.length) stored = mediaLibrary.upsert(dataDir, harvested.map((item) => catalogueItem(item, item.kind)));

  let archive = { ok: false, ms: null, items: 0, error: null };
  if (options.includeArchive !== false && ARCHIVE_PAGES > 0) {
    const archiveStarted = Date.now();
    // Same rotating-window idea as the providers: the archive's open-license collections
    // hold far more than one pass reads, so remember where this pass stopped.
    const priorArchivePage = positiveInt((readHealth(dataDir).archive || {}).nextPage) || 1;
    try {
      const found = await archiveLib.harvest({ pages: ARCHIVE_PAGES, rows: ARCHIVE_ROWS, kinds, startPage: priorArchivePage });
      const archiveStored = found.length ? mediaLibrary.upsert(dataDir, found.map(archiveItem)) : null;
      const collectionErrors = (found.errors || []).slice(0, 6);
      archive = {
        ok: true,
        ms: Date.now() - archiveStarted,
        items: found.length,
        stored: archiveStored && archiveStored.total || 0,
        windowStart: priorArchivePage,
        nextPage: positiveInt(found.nextPage) || 1,
        collections: (archiveLib.COLLECTIONS || []).filter((collection) => kinds.includes(collection.kind)).map((collection) => collection.id),
        errors: collectionErrors,
        error: collectionErrors.length ? collectionErrors.map((entry) => entry.collection + ': ' + entry.error).join('; ').slice(0, 300) : null,
      };
    } catch (error) {
      archive = { ok: false, ms: Date.now() - archiveStarted, items: 0, error: String(error && error.message || error).slice(0, 180) };
    }
  }

  // Rich movie metadata (poster, overview, release year) for harvested titles that
  // arrived without artwork; TMDB when configured, keyless TVmaze for series.
  let metadata = { enabled: false, tmdbConfigured: Boolean(TMDB_KEY), attempted: 0, enriched: 0, providers: {}, errors: [] };
  if (harvested.length && options.enrich !== false) {
    metadata = await enrichMetadata(dataDir, harvested.map((item) => catalogueItem(item, item.kind)), { limit: options.enrichLimit });
  }

  const providers = results.map((result, index) => {
    const source = sources[index];
    if (!result || result.status === 'rejected') {
      return { id: source.id, name: source.name, api: vodLib.redactUrl(source.api), ok: false, broken: true, ms: null, httpStatus: null, requests: 0, received: 0, titles: 0, kindCounts: {}, categories: 0, error: String(result && result.reason && result.reason.message || 'provider failed').slice(0, 180), checkedAt: new Date().toISOString() };
    }
    const value = result.value;
    const titles = value.items.length;
    // A provider that answers but yields nothing usable is not silently "fine".
    const broken = titles === 0;
    return {
      id: source.id,
      name: source.name,
      api: vodLib.redactUrl(source.api),
      ok: value.ok,
      broken,
      available: value.ok || value.received > 0,
      ms: value.ms,
      slow: Number.isFinite(value.ms) && value.ms >= 5000,
      httpStatus: value.received > 0 ? 200 : null,
      requests: value.requests,
      received: value.received,
      titles,
      kindCounts: value.kindCounts,
      categories: value.tree && value.tree.names ? Object.keys(value.tree.names).length : 0,
      listAction: vodLib.preferredListAction(source),
      pageCount: positiveInt(value.pageCount),
      catalogueTotal: positiveInt(value.total),
      windowStart: positiveInt(value.windowStart),
      nextPage: positiveInt(value.nextPage) || 1,
      error: value.error,
      checkedAt: new Date().toISOString(),
    };
  });

  const summary = {
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    kinds,
    pagesPerProvider: pages,
    sources: sources.length,
    providers: providers.sort((a, b) => (b.titles - a.titles) || String(a.name).localeCompare(String(b.name))),
    archive,
    metadata,
    migrated: { legacyArchiveIds },
    totals: {
      harvested: harvested.length,
      stored: stored && stored.total || 0,
      byKind: harvested.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {}),
      providersOnline: providers.filter((p) => p.available).length,
      providersBroken: providers.filter((p) => p.broken).length,
      metadataEnriched: metadata.enriched || 0,
    },
  };
  try { writeHealth(dataDir, summary); } catch { /* health file is best effort */ }
  return summary;
}

// ---------------------------------------------------------------- index browsing

const indexCache = { file: null, mtimeMs: 0, items: [] };
function readIndex(dataDir) {
  const file = mediaLibrary.filePath(dataDir);
  try {
    const stat = fs.statSync(file);
    if (indexCache.file === file && indexCache.mtimeMs === stat.mtimeMs) return indexCache.items;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(parsed.items) ? parsed.items.filter((item) => item && item.id && item.name) : [];
    indexCache.file = file; indexCache.mtimeMs = stat.mtimeMs; indexCache.items = items;
    return items;
  } catch { indexCache.file = file; indexCache.mtimeMs = 0; indexCache.items = []; return []; }
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function kindOf(item) {
  const kind = item.kind || 'video';
  return kind === 'video' ? 'movies' : kind;
}
function isVodItem(item) {
  return BROWSE_KINDS.includes(kindOf(item)) || item.kind === 'video';
}
function matchesKind(item, kind) {
  if (kind === 'all') return isVodItem(item);
  if (kind === 'movies') return ['movies', 'video'].includes(item.kind || 'video');
  return kindOf(item) === kind;
}
function toBrowseItem(item) {
  const sourceId = item.sourceId || 'saved';
  const vodId = item.vodId || item.id;
  return {
    id: sourceId === 'archive' ? 'vod-archive-' + vodId : 'vod-' + sourceId + '-' + vodId,
    vod: true,
    vodId,
    sourceId,
    sourceName: item.sourceName || sourceId,
    name: item.name,
    logo: item.logo || null,
    country: null,
    cats: [item.category || kindOf(item)],
    year: item.year || '',
    remarks: item.kind === 'video' ? 'Saved' : (item.remarks || ''),
    overview: item.overview || '',
    pageUrl: item.pageUrl || null,
    licenseUrl: item.licenseUrl || null,
    streams: 1,
    labels: [],
    kind: item.kind || 'video',
  };
}

function browse(dataDir, params = {}) {
  const kind = BROWSE_KINDS.includes(params.kind) ? params.kind : 'all';
  const q = normalizeText(params.q);
  const words = q.split(' ').filter(Boolean);
  const limit = Math.max(1, Math.min(120, Number.parseInt(params.limit, 10) || KIND_DEFAULT_LIMIT));
  const requestedPage = Math.max(1, Number.parseInt(params.page, 10) || 1);
  const all = readIndex(dataDir).filter(isVodItem);
  const sourceId = String(params.sourceId || '').trim();
  const byKind = all.filter((item) => matchesKind(item, kind) && (!sourceId || String(item.sourceId || '') === sourceId));
  const hits = words.length
    ? byKind.filter((item) => {
      const haystack = normalizeText([item.name, item.year, item.category, item.overview, item.sourceName].join(' '));
      return words.every((word) => haystack.includes(word));
    })
    : byKind;
  hits.sort((a, b) => String(b.addedAt || b.updatedAt || '').localeCompare(String(a.addedAt || a.updatedAt || '')) || String(a.name).localeCompare(String(b.name)));
  const pages = Math.max(1, Math.ceil(hits.length / limit));
  const page = Math.min(requestedPage, pages);
  const counts = { all: all.length };
  for (const value of BROWSE_KINDS) counts[value] = all.filter((item) => matchesKind(item, value)).length;
  return {
    total: hits.length,
    libraryTotal: all.length,
    counts,
    page,
    pages,
    limit,
    items: hits.slice((page - 1) * limit, page * limit).map(toBrowseItem),
  };
}

// --------------------------------------------------------- live search + refresh

async function searchProviders(sources, term, options = {}) {
  const list = (sources || []).filter((source) => source.enabled !== false);
  const results = await mapLimit(list, Math.max(1, options.concurrency || CONCURRENCY), async (source) => {
    const started = Date.now();
    const items = await vodLib.searchSource(source, term, Math.max(1, options.page || 1));
    return { source, items, ms: Date.now() - started };
  });
  const items = [];
  const providers = [];
  const errors = [];
  results.forEach((result, index) => {
    const source = list[index];
    if (result.status !== 'fulfilled') {
      const error = String(result.reason && result.reason.message || 'provider failed').slice(0, 180);
      providers.push({ name: source.name, ok: false, ms: null, received: 0, count: 0, error });
      errors.push({ source: source.name, error });
      return;
    }
    const value = result.value;
    let count = 0;
    for (const item of value.items) {
      if (vodLib.isShortForm(item)) continue;
      items.push(item);
      count += 1;
    }
    providers.push({ name: source.name, ok: true, ms: value.ms, slow: value.ms >= 5000, received: value.items.length, count, error: null });
  });
  return { items, providers, errors };
}

const refreshState = { promise: null, startedAt: 0, lastSummary: null };

function state(dataDir) {
  const health = readHealth(dataDir);
  const stored = readIndex(dataDir).filter(isVodItem).length;
  const updatedAt = health.updatedAt ? Date.parse(health.updatedAt) : 0;
  const ageMs = updatedAt ? Date.now() - updatedAt : null;
  return {
    updatedAt: health.updatedAt,
    ageMs,
    storedTitles: stored,
    refreshMinutes: REFRESH_MINUTES,
    refreshing: Boolean(refreshState.promise),
    providers: health.providers,
    archive: health.archive,
    metadata: health.metadata || null,
    totals: health.totals,
    durationMs: health.durationMs,
    options: {
      pagesPerProvider: PROVIDER_PAGES,
      freshPagesPerProvider: FRESH_PAGES,
      pageLimit: PROVIDER_PAGE_LIMIT,
      concurrency: CONCURRENCY,
      archivePages: ARCHIVE_PAGES,
      archiveRows: ARCHIVE_ROWS,
    },
  };
}

function isStale(dataDir) {
  const health = readHealth(dataDir);
  if (!health.updatedAt) return true;
  const age = Date.now() - Date.parse(health.updatedAt);
  return !Number.isFinite(age) || age > REFRESH_MINUTES * 60000;
}

function ensureFresh(dataDir, options = {}) {
  if (refreshState.promise) return refreshState.promise;
  if (!options.force && !isStale(dataDir)) return Promise.resolve(null);
  refreshState.startedAt = Date.now();
  refreshState.promise = refreshCatalogue({ dataDir, ...options })
    .then((summary) => { refreshState.lastSummary = summary; return summary; })
    .catch((error) => { console.error('vod catalogue refresh failed:', error && error.message || error); return null; })
    .finally(() => { refreshState.promise = null; });
  return refreshState.promise;
}

module.exports = {
  PROVIDER_PAGES, PROVIDER_PAGE_LIMIT, CONCURRENCY, REFRESH_MINUTES, ARCHIVE_PAGES, ARCHIVE_ROWS, BROWSE_KINDS,
  healthPath, readHealth, writeHealth, categoryTree, typeIdsFor, harvestSource, refreshCatalogue,
  browse, searchProviders, state, isStale, ensureFresh, readIndex, catalogueItem, mapLimit,
  pruneLegacyArchiveIds, repairLegacyArchiveIds,
};
