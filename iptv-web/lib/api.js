'use strict';
// JSON API + M3U export over the catalog.
const { sendJson, escapeXml } = require('./util');
const { Catalog } = require('./catalog');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const { parseM3U, isHlsManifest } = require('./m3u');
const { readBody } = require('./util');
const sourceLib = require('./sources');
const vodLib = require('./vod');
const { matchesAdminCredentials } = require('./admin-auth');
const archiveLib = require('./archive-vod');
const commonsLib = require('./commons-vod');
const mediaLibrary = require('./media-library');
const catalogLib = require('./vod-catalog');
const { withLock, withFileLock } = require('./registry-lock');

// Absolute origin as the browser sees it (proxy sets X-Forwarded-Proto).
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function createApi(catalog, refresh, dataDir) {
  const sourceDataDir = dataDir || require('path').join(__dirname, '..', 'data');
  sourceLib.ensureSourcesEnabled(sourceDataDir);
  vodLib.ensureDefaultSources(sourceDataDir);
  const vodSearchCache = new Map();
  const liveLockKey = 'live-sources:' + sourceDataDir;
  const vodLockKey = 'vod-sources:' + sourceDataDir;
  const withLiveLock = (fn) => withFileLock(sourceLib.sourcesPath(sourceDataDir) + '.lock', () => withLock(liveLockKey, fn));

  function authorizeSourceWrite(req, res) {
    if (req && req.adminAuthenticated === true) return true;
    if (matchesAdminCredentials(req)) { req.adminAuthenticated = true; return true; }
    sendJson(req, res, 401, { error: 'Please sign in with the admin username and password. API tokens are disabled.' });
    return false;
  }

  const sourceList = (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
    sendJson(req, res, 200, { sources: sources.map(publicSource) });
  };

  const enableAllSources = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const count = await withLiveLock(() => {
        const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
        for (const source of sources) source.enabled = true;
        sourceLib.saveSources(sourceDataDir, sources, { allSourcesEnabledOnce: true });
        return sources.length;
      });
      const stats = await refresh();
      sendJson(req, res, 200, { ok: true, count, stats });
    } catch (err) {
      sendJson(req, res, err.statusCode || 500, { error: err.message || 'could not enable IPTV sources' });
    }
  };

  const addSource = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const name = String(body.name || '').trim().slice(0, 80);
      const url = String(body.url || '').trim();
      if (!name) return sendJson(req, res, 400, { error: 'source name is required' });
      if (!sourceLib.isHttpUrl(url)) return sendJson(req, res, 400, { error: 'URL must use http or https' });

      const candidate = { id: sourceLib.newId(), name, url, enabled: body.enabled !== false, createdAt: new Date().toISOString() };
      const items = await sourceLib.fetchSource(candidate);
      candidate.lastCount = sourceLib.buildChannels(candidate, items).length;
      candidate.lastStreamCount = items.length;
      candidate.lastUpdated = new Date().toISOString();
      candidate.lastError = null;

      await withLiveLock(() => {
        const sources = sourceLib.loadSourcesSync(sourceDataDir).sources;
        if (sources.length >= sourceLib.MAX_SOURCES) throw Object.assign(new Error('maximum ' + sourceLib.MAX_SOURCES + ' sources reached'), { statusCode: 409 });
        if (sources.some((source) => source.url === url)) throw Object.assign(new Error('this source URL already exists'), { statusCode: 409 });
        sources.push(candidate);
        sourceLib.saveSources(sourceDataDir, sources);
      });
      const stats = await refresh();
      sendJson(req, res, 201, { source: publicSource(candidate), stats });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not add source' });
    }
  };

  const updateSource = async (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 80);
        if (!name) return sendJson(req, res, 400, { error: 'source name cannot be empty' });
        patch.name = name;
      }
      if (body.url !== undefined) {
        const url = String(body.url).trim();
        if (!sourceLib.isHttpUrl(url)) return sendJson(req, res, 400, { error: 'URL must use http or https' });
        await sourceLib.fetchSource({ id: params.id, name: patch.name || 'Validation', url });
        patch.url = url;
      }
      if (body.enabled !== undefined) patch.enabled = body.enabled === true;

      const updated = await withLock(liveLockKey, () => {
        const sources = sourceLib.loadSourcesSync(sourceDataDir).sources;
        const src = sources.find((source) => source.id === params.id);
        if (!src) throw Object.assign(new Error('source not found'), { statusCode: 404 });
        if (patch.url && sources.some((source) => source.id !== src.id && source.url === patch.url)) {
          throw Object.assign(new Error('this source URL already exists'), { statusCode: 409 });
        }
        Object.assign(src, patch);
        sourceLib.saveSources(sourceDataDir, sources);
        return { ...src };
      });
      const stats = await refresh();
      sendJson(req, res, 200, { source: publicSource(updated), stats });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not update source' });
    }
  };

  const deleteSource = async (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
    const next = sources.filter((s) => s.id !== params.id);
    if (next.length === sources.length) return sendJson(req, res, 404, { error: 'source not found' });
    sourceLib.saveSources(sourceDataDir, next);
    try {
      const stats = await refresh();
      sendJson(req, res, 200, { ok: true, stats });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || 'source deleted but catalogue refresh failed' });
    }
  };

  function publicSource(s) {
    return { id: s.id, name: s.name, url: vodLib.redactUrl(s.url), enabled: s.enabled !== false, count: s.lastCount || 0, streams: s.lastStreamCount || 0, updated: s.lastUpdated || null, error: s.lastError || null };
  }
  const listVodSources = (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    const { sources } = vodLib.loadSourcesSync(sourceDataDir);
    sendJson(req, res, 200, { sources: sources.map(vodLib.publicSource) });
  };

  const enableAllVodSources = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const count = await withLock(vodLockKey, () => {
        const registry = vodLib.loadSourcesSync(sourceDataDir);
        for (const source of registry.sources) source.enabled = true;
        vodLib.saveSources(sourceDataDir, registry.sources, { allSourcesEnabledOnce: true });
        return registry.sources.length;
      });
      vodSearchCache.clear();
      sendJson(req, res, 200, { ok: true, count });
    } catch (err) {
      sendJson(req, res, err.statusCode || 500, { error: err.message || 'could not enable Theatre sources' });
    }
  };

  const addVodSource = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const name = String(body.name || '').trim().slice(0, 80);
      const apiUrl = vodLib.normalizeApiUrl(body.api);
      const kind = vodLib.KINDS.has(body.kind) ? body.kind : 'all';
      if (!name) return sendJson(req, res, 400, { error: 'provider name is required' });
      const source = {
        id: vodLib.newId(), name, api: apiUrl, kind, enabled: body.enabled !== false,
        addedAt: new Date().toISOString(), lastChecked: null, lastError: null,
      };
      const probe = await vodLib.probeSource(source);
      source.lastChecked = new Date().toISOString();
      source.lastItemCount = probe.count;
      source.listAction = probe.action;
      await withLock(vodLockKey, () => {
        const current = vodLib.loadSourcesSync(sourceDataDir).sources;
        if (current.length >= vodLib.MAX_VOD_SOURCES) throw Object.assign(new Error('VOD provider limit reached'), { statusCode: 409 });
        if (current.some((item) => item.api === apiUrl)) throw Object.assign(new Error('this API URL already exists'), { statusCode: 409 });
        current.push(source);
        vodLib.saveSources(sourceDataDir, current);
      });
      vodSearchCache.clear();
      sendJson(req, res, 201, { source: vodLib.publicSource(source), probe });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not add VOD provider' });
    }
  };

  const importVodSourceList = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 1024 * 1024));
      let config;
      let importedFrom = null;
      if (body.url) {
        const listUrl = vodLib.normalizeApiUrl(body.url);
        const { response } = await upstreamFetch(listUrl, {
          timeoutMs: 15000,
          extraHeaders: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
        });
        if (!response.ok) return sendJson(req, res, 502, { error: 'Source list returned HTTP ' + response.status });
        const length = Number(response.headers.get('content-length') || 0);
        if (length > 1024 * 1024) return sendJson(req, res, 413, { error: 'Source list must be at most 1 MB' });
        const raw = await bodyToString(response);
        if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) return sendJson(req, res, 413, { error: 'Source list must be at most 1 MB' });
        try { config = JSON.parse(raw.replace(/^\\uFEFF/, '')); }
        catch { return sendJson(req, res, 400, { error: 'Source list URL must return JSON' }); }
        importedFrom = listUrl;
      } else if (body.config && typeof body.config === 'object') {
        config = body.config;
        importedFrom = String(body.sourceName || 'uploaded config').slice(0, 120);
      } else {
        return sendJson(req, res, 400, { error: 'Provide a source-list URL or upload a JSON configuration.' });
      }

      let candidates = [];
      try { candidates = vodLib.parseSourceList(config); }
      catch (err) {
        if (!Array.isArray(config && config.liveSources) && !Array.isArray(config && config.lives)) throw err;
      }
      const liveCandidates = sourceLib.parseRegistrySources(config);
      if (!candidates.length && !liveCandidates.length) {
        return sendJson(req, res, 400, { error: 'No compatible VOD or live source entries were found in this configuration.' });
      }

      // VOD APIs are tested before they are persisted or made available to search.
      const initialVod = vodLib.loadSourcesSync(sourceDataDir).sources;
      const initialVodUrls = new Set(initialVod.map((source) => source.api));
      const vodDuplicates = candidates.filter((candidate) => initialVodUrls.has(candidate.api)).length;
      const vodAvailable = Math.max(0, vodLib.MAX_VOD_SOURCES - initialVod.length);
      const vodUntried = candidates.filter((candidate) => !initialVodUrls.has(candidate.api));
      const vodProbeLimit = Math.min(100, Math.max(0, vodAvailable * 3));
      const vodToProbe = vodUntried.slice(0, vodProbeLimit);
      const vodProbed = await mapLimit(vodToProbe, 3, async (item) => {
        const source = {
          id: vodLib.newId(), name: item.name, api: item.api, detail: item.detail || null,
          kind: item.kind, enabled: true, addedAt: new Date().toISOString(),
          lastChecked: null, lastError: null, importedFrom,
        };
        const probe = await vodLib.probeSource(source);
        source.lastChecked = new Date().toISOString();
        source.lastItemCount = probe.count;
        source.listAction = probe.action;
        return source;
      });
      const vodAccepted = [];
      const vodRejected = [];
      for (let i = 0; i < vodProbed.length; i++) {
        const entry = vodProbed[i];
        if (entry.status === 'rejected') {
          vodRejected.push({ name: vodToProbe[i].name, error: String(entry.reason && entry.reason.message || 'provider probe failed').slice(0, 180) });
        } else {
          vodAccepted.push(entry.value);
        }
      }
      const vodSkippedLimit = Math.max(0, vodUntried.length - vodToProbe.length);
      let vodAdded = [];
      if (vodAccepted.length) {
        await withLock(vodLockKey, () => {
          const current = vodLib.loadSourcesSync(sourceDataDir).sources;
          const urls = new Set(current.map((source) => source.api));
          const capacity = Math.max(0, vodLib.MAX_VOD_SOURCES - current.length);
          vodAdded = vodAccepted.filter((source) => !urls.has(source.api)).slice(0, capacity);
          if (vodAdded.length) vodLib.saveSources(sourceDataDir, current.concat(vodAdded));
        });
      }

      // LibreTV SourceList v2 may include liveSources alongside VOD APIs. Parse, probe,
      // and save both resource classes so importing one file manages the complete project.
      const initialLive = sourceLib.loadSourcesSync(sourceDataDir).sources;
      const initialLiveUrls = new Set(initialLive.map((source) => source.url));
      const liveDuplicates = liveCandidates.filter((candidate) => initialLiveUrls.has(candidate.url)).length;
      const liveAvailable = Math.max(0, sourceLib.MAX_SOURCES - initialLive.length);
      const liveUntried = liveCandidates.filter((candidate) => !initialLiveUrls.has(candidate.url));
      const liveProbeLimit = Math.min(100, Math.max(0, liveAvailable * 3));
      const liveToProbe = liveUntried.slice(0, liveProbeLimit);
      const liveProbed = await mapLimit(liveToProbe, 3, async (item) => {
        const source = {
          id: sourceLib.newId(), name: item.name, url: item.url, epg: item.epg,
          enabled: true, createdAt: new Date().toISOString(), importedFrom,
        };
        const parsedItems = await sourceLib.fetchSource(source);
        source.lastCount = sourceLib.buildChannels(source, parsedItems).length;
        source.lastStreamCount = parsedItems.length;
        source.lastUpdated = new Date().toISOString();
        source.lastError = null;
        return source;
      });
      const liveAccepted = [];
      const liveRejected = [];
      for (let i = 0; i < liveProbed.length; i++) {
        const entry = liveProbed[i];
        if (entry.status === 'rejected') {
          liveRejected.push({ name: liveToProbe[i].name, error: String(entry.reason && entry.reason.message || 'playlist validation failed').slice(0, 180) });
        } else {
          liveAccepted.push(entry.value);
        }
      }
      const liveSkippedLimit = Math.max(0, liveUntried.length - liveToProbe.length);
      let liveAdded = [];
      if (liveAccepted.length) {
        await withLock(liveLockKey, () => {
          const current = sourceLib.loadSourcesSync(sourceDataDir).sources;
          const urls = new Set(current.map((source) => source.url));
          const capacity = Math.max(0, sourceLib.MAX_SOURCES - current.length);
          liveAdded = liveAccepted.filter((source) => !urls.has(source.url)).slice(0, capacity);
          if (liveAdded.length) sourceLib.saveSources(sourceDataDir, current.concat(liveAdded));
        });
      }

      if (vodAdded.length) vodSearchCache.clear();
      let liveRefresh = null;
      if (liveAdded.length) {
        try { liveRefresh = await refresh(); }
        catch (err) { liveRefresh = { error: String(err.message || err) }; }
      }
      const imported = vodAdded.length + liveAdded.length;
      sendJson(req, res, imported ? 201 : 200, {
        ok: true,
        imported,
        vodImported: vodAdded.length,
        liveImported: liveAdded.length,
        vodDuplicates,
        liveDuplicates,
        vodRejected,
        liveRejected,
        vodSkippedLimit,
        liveSkippedLimit,
        vodSources: vodAdded.map(vodLib.publicSource),
        liveSources: liveAdded.map(publicSource),
        liveRefresh,
        note: 'Imported providers passed API/playlist compatibility checks. These checks do not establish copyright ownership or distribution rights.',
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not import source list' });
    }
  };

  const updateVodSource = async (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const initial = vodLib.loadSourcesSync(sourceDataDir).sources.find((item) => item.id === params.id);
      if (!initial) return sendJson(req, res, 404, { error: 'VOD provider not found' });
      const patch = {};
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 80);
        if (!name) return sendJson(req, res, 400, { error: 'provider name cannot be empty' });
        patch.name = name;
      }
      if (body.kind !== undefined) {
        if (!vodLib.KINDS.has(body.kind)) return sendJson(req, res, 400, { error: 'kind must be all, movies, series, or anime' });
        patch.kind = body.kind;
      }
      if (body.api !== undefined) {
        const apiUrl = vodLib.normalizeApiUrl(body.api);
        if (apiUrl !== initial.api) {
          const candidate = { ...initial, api: apiUrl };
          const probe = await vodLib.probeSource(candidate);
          patch.api = apiUrl;
          patch.lastChecked = new Date().toISOString();
          patch.lastItemCount = probe.count;
          patch.listAction = probe.action;
          patch.lastError = null;
        }
      }
      if (body.enabled !== undefined) patch.enabled = body.enabled === true;
      const updated = await withLock(vodLockKey, () => {
        const current = vodLib.loadSourcesSync(sourceDataDir).sources;
        const source = current.find((item) => item.id === params.id);
        if (!source) throw Object.assign(new Error('VOD provider not found'), { statusCode: 404 });
        if (patch.api && current.some((item) => item.id !== params.id && item.api === patch.api)) {
          throw Object.assign(new Error('this API URL already exists'), { statusCode: 409 });
        }
        Object.assign(source, patch);
        vodLib.saveSources(sourceDataDir, current);
        return { ...source };
      });
      vodSearchCache.clear();
      sendJson(req, res, 200, { source: vodLib.publicSource(updated) });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not update VOD provider' });
    }
  };

  const deleteVodSource = async (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const removed = await withLock(vodLockKey, () => {
        const current = vodLib.loadSourcesSync(sourceDataDir).sources;
        const next = current.filter((item) => item.id !== params.id);
        if (next.length === current.length) return false;
        vodLib.saveSources(sourceDataDir, next);
        return true;
      });
      if (!removed) return sendJson(req, res, 404, { error: 'VOD provider not found' });
      vodSearchCache.clear();
      sendJson(req, res, 200, { ok: true });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || 'could not delete VOD provider' });
    }
  };

  const librarySearch = (req, res, params, query) => {
    const q = String(query.q || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const words = q.split(' ').filter(Boolean);
    const type = ['all', 'channel', 'movies', 'series', 'anime', 'documentary', 'video'].includes(query.type) ? query.type : 'all';
    const channels = (type === 'all' || type === 'channel' ? catalog.channels : []).filter(channel => {
      const haystack = String(channel._s || channel.name || '').normalize('NFKC').toLocaleLowerCase();
      return !words.length || words.every(word => haystack.includes(word));
    }).map(channel => ({
      id: 'channel-' + channel.id, name: channel.name, title: channel.name, logo: channel.logo || null,
      kind: 'channel', sourceId: 'iptv-org', sourceName: 'Live channel catalog',
      category: (channel.cats || []).join(', '), year: '', episodes: [],
    }));
    const saved = mediaLibrary.allItems(sourceDataDir).filter(item => {
      const kind = item.kind || 'channel';
      const kindMatch = type === 'all' || kind === type || (type === 'movies' && kind === 'video');
      const text = String([item.name, item.overview, item.year, item.category, item.sourceName,
        ...(Array.isArray(item.episodes) ? item.episodes.map(ep => ep && ep.title || '') : [])].join(' '))
        .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
      return kindMatch && (!words.length || words.every(word => text.includes(word)));
    });
    const merged = [...channels, ...saved].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 48));
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const stats = mediaLibrary.stats(sourceDataDir);
    sendJson(req, res, 200, {
      total: merged.length, page, limit, pages: Math.max(1, Math.ceil(merged.length / limit)),
      items: merged.slice((page - 1) * limit, page * limit).map(item => ({
        id: item.id, name: item.name, title: item.title || item.name, logo: item.logo || null,
        kind: item.kind || 'channel', sourceId: item.sourceId || null, sourceName: item.sourceName || null,
        category: item.category || '', year: item.year || '', overview: item.overview || '',
        episodes: Array.isArray(item.episodes) ? item.episodes.map(ep => ({ title: ep.title })) : [],
        pageUrl: item.pageUrl || null, licenseUrl: item.licenseUrl || null,
      })),
      updatedAt: stats.updatedAt, channelCatalogCount: catalog.channels.length,
    });
  };

  const libraryStats = (req, res) => sendJson(req, res, 200, {
    ...mediaLibrary.stats(sourceDataDir), channelCatalogCount: catalog.channels.length,
  });

  const saveLibraryItem = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 65536));
      const result = mediaLibrary.upsert(sourceDataDir, body.items || body.item || body);
      sendJson(req, res, 201, { ok: true, ...result });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not save media item' });
    }
  };

  const deleteLibraryItem = (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    if (!mediaLibrary.remove(sourceDataDir, params.id)) return sendJson(req, res, 404, { error: 'media item not found' });
    sendJson(req, res, 200, { ok: true, ...mediaLibrary.stats(sourceDataDir) });
  };

  const vodSearchLegacy = async (req, res, params, query) => {
    const kind = vodLib.KINDS.has(query.type) ? query.type : 'all';
    const term = String(query.q || '').trim().slice(0, 120);
    const cacheKey = kind + '\u0000' + term.toLowerCase();
    const cached = vodSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 45000) return sendJson(req, res, 200, cached.payload);

    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const sources = registry.sources.filter((s) => s.enabled !== false && (kind === 'all' || s.kind === kind || s.kind === 'all'));
    // Always include the license-filtered Archive catalogue for movie/anime searches.
    // It remains available even when configured providers return no results or fail.
    const archiveSearch = !['series', 'documentary'].includes(kind)
      ? archiveLib.search(term, kind, 30)
      : null;
    const [results, archiveResults] = await Promise.all([
      Promise.allSettled(sources.map((source) => vodLib.searchSource(source, term, 1))),
      archiveSearch ? Promise.allSettled([archiveSearch]) : Promise.resolve([]),
    ]);
    const archiveResult = archiveResults[0] || null;
    const items = [];
    const errors = [];
    const sourceCounts = sources.map(() => 0);
    let archiveCount = 0;
    let archiveReceived = 0;
    let filteredShortForm = 0;

    results.forEach((result, index) => {
      const source = sources[index];
      if (result.status !== 'fulfilled') {
        errors.push({ source: source.name, error: String(result.reason && result.reason.message || 'provider failed').slice(0, 180) });
        return;
      }
      for (const item of result.value) {
        if (vodLib.isShortForm(item)) {
          filteredShortForm++;
          continue;
        }
        if (kind !== 'all' && source.kind === 'all' && item.kind !== kind) continue;
        items.push({
          id: 'vod-' + item.sourceId + '-' + item.id,
          vod: true,
          vodId: item.id,
          sourceId: item.sourceId,
          sourceName: item.sourceName,
          name: item.name,
          logo: item.logo,
          country: null,
          cats: [item.category || (kind === 'all' ? 'VOD' : kind)],
          year: item.year,
          remarks: item.remarks,
          overview: item.overview,
          streams: 1,
          labels: [],
          kind: item.kind,
        });
        sourceCounts[index]++;
      }
    });

    // Internet Archive is a built-in, always-on source for movie/anime searches.
    // Its own metadata must declare public-domain or compatible Creative Commons rights.
    // Configured providers are still searched alongside it; unverified third-party
    // scrape APIs are not automatically enabled by this change.
    if (archiveResult) {
      if (archiveResult.status !== 'fulfilled') {
        errors.push({ source: 'Internet Archive (open-license fallback)', error: String(archiveResult.reason && archiveResult.reason.message || 'archive search failed').slice(0, 180) });
      } else {
        archiveReceived = archiveResult.value.length;
        for (const item of archiveResult.value) {
          const shortForm = vodLib.isShortForm(item);
          if (shortForm) filteredShortForm++;
          if (shortForm || (kind !== 'all' && item.kind !== kind)) continue;
          items.push({
            id: 'vod-archive-' + item.id,
            vod: true,
            vodId: item.id,
            sourceId: 'archive',
            sourceName: item.sourceName || 'Internet Archive (open-license fallback)',
            name: item.name,
            logo: item.logo || null,
            country: null,
            cats: [item.category || (kind === 'all' ? item.kind : kind)],
            year: item.year || '',
            remarks: item.remarks || 'Open-license video',
            overview: item.overview || '',
            pageUrl: item.pageUrl || null,
            licenseUrl: item.licenseUrl || null,
            streams: 1,
            labels: [],
            kind: item.kind,
          });
          archiveCount++;
        }
      }
    }
    const seen = new Set();
    const unique = items.filter((item) => {
      const key = (item.name + '|' + (item.year || '')).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const providerSummary = sources.map((source, index) => ({
      name: source.name,
      ok: results[index].status === 'fulfilled',
      received: results[index].status === 'fulfilled' ? results[index].value.length : 0,
      count: sourceCounts[index],
    }));
    if (archiveResult) providerSummary.push({
      name: 'Internet Archive (open-license fallback)',
      ok: archiveResult.status === 'fulfilled',
      received: archiveReceived,
      count: archiveCount,
    });
    // Persist discovered titles so the saved library survives restarts and provider outages.
    mediaLibrary.upsert(sourceDataDir, unique.map(item => ({ ...item, kind: item.kind || kind, vod: true })));
    const payload = {
      type: kind,
      total: unique.length,
      page: 1,
      limit: Math.min(240, unique.length),
      pages: 1,
      items: unique.slice(0, 240),
      providers: providerSummary,
      filteredShortForm,
      errors,
    };
    if (errors.length === 0) {
      vodSearchCache.set(cacheKey, { time: Date.now(), payload });
      if (vodSearchCache.size > 100) vodSearchCache.delete(vodSearchCache.keys().next().value);
    }
    sendJson(req, res, 200, payload);
  };

  const vodDetail = async (req, res, params) => {
    if (params.sourceId === 'commons') {
      try {
        const item = await commonsLib.getDetail(params.vodId);
        mediaLibrary.upsert(sourceDataDir, { ...item, id: 'vod-commons-' + item.id, vodId: item.id, sourceId: 'commons', sourceName: item.sourceName, vod: true, kind: item.kind || 'video' });
        return sendJson(req, res, 200, {
          id: item.id,
          sourceId: 'commons',
          sourceName: item.sourceName,
          name: item.name,
          logo: item.logo,
          overview: item.overview,
          year: item.year,
          category: item.category,
          remarks: item.remarks,
          licenseUrl: item.licenseUrl || null,
          pageUrl: item.pageUrl || null,
          episodes: item.episodes,
        });
      } catch (err) {
        return sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not load Commons item' });
      }
    }
    if (params.sourceId === 'archive') {
      try {
        const item = await archiveLib.getDetail(params.vodId);
        mediaLibrary.upsert(sourceDataDir, { ...item, id: 'vod-archive-' + item.id, vodId: item.id, sourceId: 'archive', sourceName: item.sourceName, vod: true, kind: item.kind || 'video' });
        return sendJson(req, res, 200, {
          id: item.id,
          sourceId: 'archive',
          sourceName: item.sourceName,
          name: item.name,
          logo: item.logo,
          overview: item.overview,
          year: item.year,
          category: item.category,
          remarks: item.remarks,
          licenseUrl: item.licenseUrl || null,
          pageUrl: item.pageUrl || null,
          episodes: item.episodes,
        });
      } catch (err) {
        return sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not load Internet Archive item' });
      }
    }
    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const source = registry.sources.find((s) => s.id === params.sourceId && s.enabled !== false);
    if (!source) return sendJson(req, res, 404, { error: 'VOD provider not found or disabled' });
    try {
      const item = await vodLib.getDetail(source, params.vodId);
      mediaLibrary.upsert(sourceDataDir, { ...item, id: 'vod-' + source.id + '-' + item.id, vodId: item.id, sourceId: source.id, sourceName: source.name, vod: true, kind: item.kind || source.kind || 'video' });
      sendJson(req, res, 200, {
        id: item.id,
        sourceId: source.id,
        sourceName: source.name,
        name: item.name,
        logo: item.logo,
        overview: item.overview,
        year: item.year,
        category: item.category,
        remarks: item.remarks,
        episodes: item.episodes,
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not load video details' });
    }
  };

  const meta = (req, res) => {
    sendJson(req, res, 200, Object.assign({}, catalog.meta, { ready: catalog.ready }));
  };

  const channels = (req, res, params, query) => {
    if (!catalog.ready) return sendJson(req, res, 503, { error: 'catalog not built yet', hint: 'POST /api/refresh' });
    sendJson(req, res, 200, catalog.query(query));
  };

  const channel = (req, res, params) => {
    const c = catalog.get(params.id);
    if (!c) return sendJson(req, res, 404, { error: 'unknown channel', id: params.id });
    sendJson(req, res, 200, Catalog.detail(c));
  };

  const refreshNow = async (req, res) => {
    try {
      const stats = await refresh();
      sendJson(req, res, 200, { ok: true, stats, meta: catalog.meta });
    } catch (err) {
      sendJson(req, res, 500, { ok: false, error: err.message });
    }
  };

  // Import any external M3U playlist server-side (no CORS in the way).
  const playlist = async (req, res, params, query) => {
    const url = query.u;
    if (!url) return sendJson(req, res, 400, { error: 'missing u' });
    try {
      const { response, url: finalUrl } = await upstreamFetch(url, { timeoutMs: 20000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await bodyToString(response);
      if (isHlsManifest(text)) throw Object.assign(new Error('that URL is a single stream, not a playlist'), { statusCode: 400 });
      const items = parseM3U(text);
      if (!items.length) throw new Error('no channels found in playlist');
      sendJson(req, res, 200, {
        source: finalUrl,
        count: items.length,
        items: items.slice(0, 5000).map((i, n) => ({
          key: i.id || `pl-${n}`,
          name: i.name,
          logo: i.logo,
          group: i.group,
          country: i.country,
          referrer: i.referrer,
          userAgent: i.userAgent,
          url: i.url,
        })),
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message, source: url });
    }
  };

  // Same URL, but proxied by us, so a browser <video> can play it directly (m3u8 only).
  const playlistProxied = async (req, res, params, query) => {
    const url = query.u;
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('#EXTM3U\n');
    }
    let items = [];
    try {
      const { response, url: finalUrl } = await upstreamFetch(url, { timeoutMs: 20000 });
      const text = await bodyToString(response);
      items = parseM3U(text).map((i) => ({ ...i, base: finalUrl }));
    } catch {
      items = [];
    }
    const origin = baseUrl(req);
    const lines = ['#EXTM3U'];
    for (const i of items) {
      const p = new URLSearchParams({ u: i.url });
      if (i.referrer) p.set('r', i.referrer);
      if (i.userAgent) p.set('ua', i.userAgent);
      lines.push(
        `#EXTINF:-1 tvg-id="${escapeXml(i.id || '')}" tvg-logo="${escapeXml(i.logo || '')}" group-title="${escapeXml(i.group || 'Imported')}",${i.name}`
      );
      lines.push(`${origin}/hls?${p.toString()}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n') + '\n');
  };

  const exportM3u = (req, res, params, query) => {
    if (!catalog.ready) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('catalog not ready\n');
    }
    const origin = baseUrl(req);
    const hits = catalog.filterAll(Object.assign({}, query, { ids: query.ids || '' }));
    const lines = ['#EXTM3U'];
    for (const c of hits) {
      const group = (c.cats || [])[0] || 'Uncategorised';
      const logo = c.logo ? `${origin}/img?u=${encodeURIComponent(c.logo)}` : '';
      for (const s of c.streams || []) {
        const p = new URLSearchParams({ u: s.u });
        if (s.r) p.set('r', s.r);
        if (s.ua) p.set('ua', s.ua);
        const outUrl = query.proxy === '1' ? `${origin}/hls?${p.toString()}` : s.u;
        lines.push(
          `#EXTINF:-1 tvg-id="${escapeXml(c.id)}" tvg-logo="${escapeXml(logo)}" group-title="${escapeXml(group)}",${c.name}${s.q ? ` (${s.q})` : ''}`
        );
        if (s.r) lines.push(`#EXTVLCOPT:http-referrer=${s.r}`);
        if (s.ua) lines.push(`#EXTVLCOPT:http-user-agent=${s.ua}`);
        lines.push(outUrl);
      }
    }
    res.writeHead(200, {
      'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      'Content-Disposition': 'attachment; filename="playlist.m3u"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(lines.join('\n') + '\n');
  };

  const health = (req, res) => {
    sendJson(req, res, catalog.ready ? 200 : 503, {
      ok: catalog.ready,
      channels: catalog.meta.total || 0,
      streams: catalog.meta.streams || 0,
      updated: catalog.meta.updated || null,
      uptime: Math.round(process.uptime()),
      node: process.version,
    });
  };

  // ------------------------------------------------------------------ catalogue
  // Browsing and searching are served from the persisted metadata index built by
  // lib/vod-catalog.js (deep, paged harvest of every enabled provider plus the open
  // licence Internet Archive collections). Providers are only contacted live for an
  // explicit search term or during a catalogue refresh; page loads never fan out.
  const BROWSE_KINDS_LIB = catalogLib.BROWSE_KINDS;

  function dedupeKey(entry) {
    return String(entry.name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') + '|' + String(entry.year || '');
  }

  function providerRowFromHealth(row) {
    return {
      name: row.name,
      ok: row.ok === true,
      available: row.available !== false && row.ok === true,
      broken: row.broken === true,
      slow: row.slow === true,
      ms: Number.isFinite(row.ms) ? row.ms : null,
      received: row.received || 0,
      count: row.titles || 0,
      categories: row.categories || 0,
      error: row.error || null,
      checkedAt: row.checkedAt || null,
    };
  }

  const vodCatalogState = (req, res) => sendJson(req, res, 200, catalogLib.state(sourceDataDir));

  const vodProviders = (req, res) => {
    const current = catalogLib.state(sourceDataDir);
    sendJson(req, res, 200, {
      updatedAt: current.updatedAt,
      ageMs: current.ageMs,
      refreshing: current.refreshing,
      storedTitles: current.storedTitles,
      refreshMinutes: current.refreshMinutes,
      totals: current.totals,
      archive: current.archive,
      options: current.options,
      providers: (current.providers || []).map(providerRowFromHealth),
      broken: (current.providers || []).filter((row) => row.broken).map((row) => ({ name: row.name, ms: row.ms, error: row.error })),
    });
  };

  const vodCatalogRefresh = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const summary = await catalogLib.refreshCatalogue({ dataDir: sourceDataDir, force: true });
      vodSearchCache.clear();
      sendJson(req, res, 200, summary);
    } catch (error) {
      sendJson(req, res, error.statusCode || 502, { error: error.message || 'catalogue refresh failed' });
    }
  };

  const vodSearch = async (req, res, params, query) => {
    const kind = BROWSE_KINDS_LIB.includes(query.type) || query.type === 'all' ? query.type : 'all';
    const term = String(query.q || '').trim().slice(0, 120);
    const limit = Math.max(1, Math.min(120, Number.parseInt(query.limit, 10) || 24));
    const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const started = Date.now();
    const health = catalogLib.state(sourceDataDir);
    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const enabled = (registry.sources || []).filter((source) => source.enabled !== false);
    const index = catalogLib.browse(sourceDataDir, { kind, q: term, page: 1, limit: 120 });

    let items = index.items;
    let total = index.total;
    let pages = index.pages;
    let providers = (health.providers || []).map(providerRowFromHealth);
    let errors = [];
    let filteredShortForm = 0;

    if (term) {
      // An explicit search still consults the providers (and the Archive) live, then
      // stores what it found so the next lookup is served from the index.
      const liveSources = enabled.filter((source) => kind === 'all' || source.kind === kind || source.kind === 'all');
      const live = await catalogLib.searchProviders(liveSources, term, { page: 1 });
      const merged = [];
      const seen = new Set();
      const push = (entry) => { const key = dedupeKey(entry); if (seen.has(key)) return; seen.add(key); merged.push(entry); };
      for (const item of live.items) {
        if (vodLib.isShortForm(item)) { filteredShortForm += 1; continue; }
        if (kind !== 'all' && item.kind !== kind && !(kind === 'movies' && item.kind === 'video')) continue;
        push(catalogLib.catalogueItem(item, item.kind));
      }
      let archiveCount = 0;
      if (!['series', 'documentary'].includes(kind)) {
        try {
          const found = await archiveLib.search(term, kind === 'all' ? 'all' : kind, 30);
          for (const found1 of found) {
            if (vodLib.isShortForm(found1)) { filteredShortForm += 1; continue; }
            if (kind !== 'all' && found1.kind !== kind) continue;
            // Bare identifier: /api/vod/archive/<id> resolves via archiveLib.getDetail(<id>).
            push(catalogLib.catalogueItem({
              id: found1.id, sourceId: 'archive',
              sourceName: found1.sourceName || 'Internet Archive (open-license fallback)',
              name: found1.name, logo: found1.logo, overview: found1.overview, category: found1.category,
              year: found1.year, remarks: found1.remarks, kind: found1.kind, pageUrl: found1.pageUrl, licenseUrl: found1.licenseUrl,
            }, found1.kind));
            archiveCount += 1;
          }
        } catch (error) {
          errors.push({ source: 'Internet Archive (open-license fallback)', error: String(error && error.message || error).slice(0, 180) });
        }
      }
      for (const entry of index.items) push(entry);
      // Persist fresh metadata (never playback URLs) so the catalogue keeps growing.
      const fresh = merged.filter((entry) => !index.items.some((existing) => existing.id === entry.id));
      if (fresh.length) {
        try {
          mediaLibrary.upsert(sourceDataDir, fresh.map((entry) => ({ ...entry, vod: true })));
          index.total += fresh.length; // reflect the write in this response
        } catch { /* persistence is best effort */ }
      }
      items = merged;
      total = merged.length;
      pages = Math.max(1, Math.ceil(total / limit));
      errors = errors.concat(live.errors);
      if (live.providers.length) {
        providers = live.providers.concat(providers.filter((row) => !live.providers.some((liveRow) => liveRow.name === row.name)));
      }
      if (archiveCount) providers = providers.concat([{ name: 'Internet Archive (open-license fallback)', ok: true, available: true, broken: false, slow: false, ms: null, received: archiveCount, count: archiveCount, error: null, checkedAt: new Date().toISOString() }]);
    } else if (index.total === 0) {
      // Nothing indexed yet (first boot, wiped index, first deploy on a new volume):
      // answer like the classic live search instead of an empty Theatre, and build the
      // index in the background so the next page load is served from it. vodSearchLegacy
      // is the original implementation, kept verbatim for exactly this cold-start case.
      catalogLib.ensureFresh(sourceDataDir).catch(() => {});
      return vodSearchLegacy(req, res, params, query);
    } else if (catalogLib.isStale(sourceDataDir)) {
      // Stale but populated: answer immediately from the index and rebuild in the
      // background (single flight, results land in the next page load).
      catalogLib.ensureFresh(sourceDataDir).catch(() => {});
    }

    const page = Math.min(requestedPage, pages);
    sendJson(req, res, 200, {
      type: kind,
      total,
      page,
      pages,
      limit,
      items: items.slice((page - 1) * limit, page * limit),
      providers,
      filteredShortForm,
      errors,
      tookMs: Date.now() - started,
      catalog: {
        updatedAt: health.updatedAt,
        ageMs: health.ageMs,
        refreshing: catalogLib.state(sourceDataDir).refreshing,
        refreshMinutes: health.refreshMinutes,
        storedTitles: index.libraryTotal,
        counts: index.counts,
        source: term ? 'live+index' : 'index',
      },
    });
  };

  return { meta, channels, channel, refreshNow, playlist, playlistProxied, exportM3u, health, sourceList, addSource, updateSource, deleteSource, enableAllSources, listVodSources, addVodSource, importVodSourceList, updateVodSource, deleteVodSource, enableAllVodSources, vodSearch, vodSearchLegacy, vodDetail, vodCatalogState, vodProviders, vodCatalogRefresh, librarySearch, libraryStats, saveLibraryItem, deleteLibraryItem, clearVodCache: () => vodSearchCache.clear() };
}

module.exports = { createApi };
