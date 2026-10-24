'use strict';
// JSON API + M3U export over the catalog.
const { sendJson, escapeXml } = require('./util');
const { Catalog } = require('./catalog');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const { parseM3U, isHlsManifest } = require('./m3u');
const { readBody } = require('./util');
const sourceLib = require('./sources');
const vodLib = require('./vod');

// Absolute origin as the browser sees it (proxy sets X-Forwarded-Proto).
function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function createApi(catalog, refresh, dataDir) {
  const sourceDataDir = dataDir || require('path').join(__dirname, '..', 'data');
  const vodSearchCache = new Map();

  function authorizeSourceWrite(req, res) {
    const expected = process.env.SOURCE_TOKEN || process.env.REFRESH_TOKEN;
    const given = req.headers['x-source-token'];
    if (!expected) {
      sendJson(req, res, 503, { error: 'source management is disabled until SOURCE_TOKEN or REFRESH_TOKEN is configured' });
      return false;
    }
    const givenBuffer = typeof given === 'string' ? Buffer.from(given) : Buffer.alloc(0);
    const expectedBuffer = Buffer.from(expected);
    if (givenBuffer.length !== expectedBuffer.length || !require('crypto').timingSafeEqual(givenBuffer, expectedBuffer)) {
      sendJson(req, res, 403, { error: 'source management token required' });
      return false;
    }
    return true;
  }

  const sourceList = (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
    sendJson(req, res, 200, { sources: sources.map(publicSource) });
  };

  const addSource = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const name = String(body.name || '').trim().slice(0, 80);
      const url = String(body.url || '').trim();
      if (!name) return sendJson(req, res, 400, { error: 'source name is required' });
      if (!sourceLib.isHttpUrl(url)) return sendJson(req, res, 400, { error: 'URL must use http or https' });
      const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
      if (sources.length >= sourceLib.MAX_SOURCES) return sendJson(req, res, 409, { error: `maximum ${sourceLib.MAX_SOURCES} sources reached` });
      if (sources.some((s) => s.url === url)) return sendJson(req, res, 409, { error: 'this source URL already exists' });
      const candidate = { id: sourceLib.newId(), name, url, enabled: body.enabled !== false, createdAt: new Date().toISOString() };
      const items = await sourceLib.fetchSource(candidate);
      candidate.lastCount = sourceLib.buildChannels(candidate, items).length;
      candidate.lastStreamCount = items.length;
      candidate.lastUpdated = new Date().toISOString();
      candidate.lastError = null;
      sources.push(candidate);
      sourceLib.saveSources(sourceDataDir, sources);
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
      const { sources } = sourceLib.loadSourcesSync(sourceDataDir);
      const src = sources.find((s) => s.id === params.id);
      if (!src) return sendJson(req, res, 404, { error: 'source not found' });
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 80);
        if (!name) return sendJson(req, res, 400, { error: 'source name cannot be empty' });
        src.name = name;
      }
      if (body.url !== undefined) {
        const url = String(body.url).trim();
        if (!sourceLib.isHttpUrl(url)) return sendJson(req, res, 400, { error: 'URL must use http or https' });
        if (sources.some((s) => s.id !== src.id && s.url === url)) return sendJson(req, res, 409, { error: 'this source URL already exists' });
        const candidate = { ...src, url };
        await sourceLib.fetchSource(candidate);
        src.url = url;
      }
      if (body.enabled !== undefined) src.enabled = body.enabled === true;
      sourceLib.saveSources(sourceDataDir, sources);
      const stats = await refresh();
      sendJson(req, res, 200, { source: publicSource(src), stats });
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
    return { id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false, count: s.lastCount || 0, streams: s.lastStreamCount || 0, updated: s.lastUpdated || null, error: s.lastError || null };
  }
  const listVodSources = (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    const { sources } = vodLib.loadSourcesSync(sourceDataDir);
    sendJson(req, res, 200, { sources: sources.map(vodLib.publicSource) });
  };

  const addVodSource = async (req, res) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const name = String(body.name || '').trim().slice(0, 80);
      const apiUrl = vodLib.normalizeApiUrl(body.api);
      const kind = vodLib.KINDS.has(body.kind) ? body.kind : 'all';
      if (!name) return sendJson(req, res, 400, { error: 'provider name is required' });
      const registry = vodLib.loadSourcesSync(sourceDataDir);
      if (registry.sources.length >= vodLib.MAX_VOD_SOURCES) return sendJson(req, res, 409, { error: 'VOD provider limit reached' });
      if (registry.sources.some((s) => s.api === apiUrl)) return sendJson(req, res, 409, { error: 'this API URL already exists' });
      const source = { id: vodLib.newId(), name, api: apiUrl, kind, enabled: body.enabled !== false, addedAt: new Date().toISOString(), lastChecked: null, lastError: null };
      const result = await vodLib.probeSource(source);
      source.lastChecked = new Date().toISOString();
      source.lastError = null;
      registry.sources.push(source);
      vodLib.saveSources(sourceDataDir, registry.sources);
      vodSearchCache.clear();
      sendJson(req, res, 201, { source: vodLib.publicSource(source), probe: result });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not add VOD provider' });
    }
  };

  const updateVodSource = async (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const registry = vodLib.loadSourcesSync(sourceDataDir);
      const source = registry.sources.find((s) => s.id === params.id);
      if (!source) return sendJson(req, res, 404, { error: 'VOD provider not found' });
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 80);
        if (!name) return sendJson(req, res, 400, { error: 'provider name cannot be empty' });
        source.name = name;
      }
      if (body.kind !== undefined) {
        if (!vodLib.KINDS.has(body.kind)) return sendJson(req, res, 400, { error: 'kind must be all, movies, series, or anime' });
        source.kind = body.kind;
      }
      if (body.api !== undefined) {
        const apiUrl = vodLib.normalizeApiUrl(body.api);
        if (registry.sources.some((s) => s.id !== source.id && s.api === apiUrl)) return sendJson(req, res, 409, { error: 'this API URL already exists' });
        const candidate = { ...source, api: apiUrl };
        await vodLib.probeSource(candidate);
        source.api = apiUrl;
        source.lastChecked = new Date().toISOString();
        source.lastError = null;
      }
      if (body.enabled !== undefined) source.enabled = body.enabled === true;
      vodLib.saveSources(sourceDataDir, registry.sources);
      vodSearchCache.clear();
      sendJson(req, res, 200, { source: vodLib.publicSource(source) });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not update VOD provider' });
    }
  };

  const deleteVodSource = (req, res, params) => {
    if (!authorizeSourceWrite(req, res)) return;
    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const sources = registry.sources.filter((s) => s.id !== params.id);
    if (sources.length === registry.sources.length) return sendJson(req, res, 404, { error: 'VOD provider not found' });
    vodLib.saveSources(sourceDataDir, sources);
    vodSearchCache.clear();
    sendJson(req, res, 200, { ok: true });
  };

  const vodSearch = async (req, res, params, query) => {
    const kind = vodLib.KINDS.has(query.type) ? query.type : 'all';
    const term = String(query.q || '').trim().slice(0, 120);
    const cacheKey = kind + '\u0000' + term.toLowerCase();
    const cached = vodSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 45000) return sendJson(req, res, 200, cached.payload);
    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const sources = registry.sources.filter((s) => s.enabled !== false && (kind === 'all' || s.kind === kind || s.kind === 'all'));
    if (!sources.length) return sendJson(req, res, 200, { type: kind, total: 0, pages: 1, items: [], providers: [], hint: 'Add an authorized Apple CMS / MacCMS VOD API in VOD resources.' });
    const results = await Promise.allSettled(sources.map((source) => vodLib.searchSource(source, term, 1)));
    const items = [];
    const errors = [];
    results.forEach((result, index) => {
      const source = sources[index];
      if (result.status === 'fulfilled') {
        for (const item of result.value) {
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
        }
      } else {
        errors.push({ source: source.name, error: String(result.reason && result.reason.message || 'provider failed').slice(0, 180) });
      }
    });
    const seen = new Set();
    const unique = items.filter((item) => {
      const key = (item.name + '|' + (item.year || '')).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const payload = {
      type: kind,
      total: unique.length,
      page: 1,
      limit: Math.min(240, unique.length),
      pages: 1,
      items: unique.slice(0, 240),
      providers: sources.map((s, i) => ({ name: s.name, ok: results[i].status === 'fulfilled' })),
      errors,
    };
    if (sources.length && errors.length === 0) {
      vodSearchCache.set(cacheKey, { time: Date.now(), payload });
      if (vodSearchCache.size > 100) vodSearchCache.delete(vodSearchCache.keys().next().value);
    }
    sendJson(req, res, 200, payload);
  };

  const vodDetail = async (req, res, params) => {
    const registry = vodLib.loadSourcesSync(sourceDataDir);
    const source = registry.sources.find((s) => s.id === params.sourceId && s.enabled !== false);
    if (!source) return sendJson(req, res, 404, { error: 'VOD provider not found or disabled' });
    try {
      const item = await vodLib.getDetail(source, params.vodId);
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

  return { meta, channels, channel, refreshNow, playlist, playlistProxied, exportM3u, health, sourceList, addSource, updateSource, deleteSource, listVodSources, addVodSource, updateVodSource, deleteVodSource, vodSearch, vodDetail };
}

module.exports = { createApi };
