'use strict';

// Radio Browser integration: DNS-SRV mirror discovery, bounded search, short caches,
// click-counter resolution, and a UUID-ticketed HTTP-stream relay for HTTPS pages.
const dns = require('dns').promises;
const crypto = require('crypto');
const { upstreamFetch, bodyToString, pipeBody } = require('./fetch-upstream');
const { assertSafeUrl, sendJson, clampInt } = require('./util');
const radioSourceStore = require('./radio-sources');
const path = require('path');

const USER_AGENT = 'IPTV-Web-Radio/1.0 (+https://github.com/bluecarbonsales-coder/iptv)';
const FALLBACK_MIRROR = 'https://de1.api.radio-browser.info';
const VALID_ORDER = new Set(['name', 'votes', 'bitrate', 'lastcheckok', 'lastchecktime', 'clicktimestamp', 'clickcount', 'clicktrend', 'changetimestamp', 'random']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_TICKET_TTL = 30 * 60 * 1000;
const MAX_TICKETS = 2000;
const MAX_STREAMS = 12;
const STREAM_TYPES = /^(audio\/|application\/(octet-stream|ogg|vnd\.apple\.mpegurl|x-mpegurl|mpegurl))/i;

function safeString(value, max = 180) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stationuuid = safeString(raw.stationuuid, 64);
  if (!UUID_RE.test(stationuuid)) return null;
  const name = safeString(raw.name, 180) || 'Unnamed radio station';
  const countrycode = safeString(raw.countrycode, 2).toUpperCase();
  return {
    stationuuid,
    name,
    countrycode: /^[A-Z]{2}$/.test(countrycode) ? countrycode : '',
    country: safeString(raw.country, 80),
    state: safeString(raw.state, 80),
    language: safeString(raw.language, 120),
    languagecodes: safeString(raw.languagecodes, 80),
    tags: safeString(raw.tags, 240),
    favicon: safeString(raw.favicon, 1024),
    homepage: safeString(raw.homepage, 1024),
    codec: safeString(raw.codec, 24).toUpperCase(),
    bitrate: clampInt(raw.bitrate, 0, 100000, 0),
    votes: clampInt(raw.votes, 0, 2147483647, 0),
    clickcount: clampInt(raw.clickcount, 0, 2147483647, 0),
    hls: raw.hls === true || raw.hls === 1 || raw.hls === '1',
    lastcheckok: raw.lastcheckok === true || raw.lastcheckok === 1 || raw.lastcheckok === '1',
  };
}

function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function getRemoteKey(req) {
  // The app is intended to sit behind a private reverse proxy; prefer its client-IP headers
  // so one proxy connection does not throttle every listener as the same visitor.
  const forwarded = String(req.headers && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) || '');
  const candidate = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
  const remote = candidate.length ? candidate[candidate.length - 1] : String(req.socket && req.socket.remoteAddress || 'unknown');
  return remote.startsWith('::ffff:') ? remote.slice(7) : remote;
}

function createRadioApi(options = {}) {
  const resolveSrv = options.resolveSrv || dns.resolveSrv.bind(dns);
  const resolve4 = options.resolve4 || dns.resolve4.bind(dns);
  const resolvePtr = options.resolvePtr || dns.resolvePtr.bind(dns);
  const fetchUpstream = options.upstreamFetch || upstreamFetch;
  const validateUrl = options.assertSafeUrl || assertSafeUrl;
  const readBody = options.bodyToString || bodyToString;
  const pipeStream = options.pipeBody || pipeBody;
  const minRequestIntervalMs = Number.isFinite(options.minRequestIntervalMs) ? options.minRequestIntervalMs : 350;
  const configuredMirrors = Array.isArray(options.mirrors) ? options.mirrors.slice() : null;
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  radioSourceStore.ensureEnabled(dataDir);
  let cachedMirrors = null;
  let mirrorsExpires = 0;
  let nextApiRequestAt = 0;
  const responseCache = new Map();
  const tickets = new Map();
  const rateBuckets = new Map();
  let activeStreams = 0;

  async function getMirrors(force = false) {
    if (configuredMirrors) return configuredMirrors.slice();
    if (!force && cachedMirrors && Date.now() < mirrorsExpires) return cachedMirrors.slice();
    let discovered = [];
    try {
      const records = await resolveSrv('_api._tcp.radio-browser.info');
      discovered = (records || [])
        .filter((record) => record && record.target && Number(record.port) > 0)
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
        .map((record) => record.target.replace(/\.$/, ''))
        .filter((host, index, list) => host.endsWith('.api.radio-browser.info') && list.indexOf(host) === index)
        .map((host) => 'https://' + host);
    } catch {}
    if (!discovered.length) {
      try {
        const addresses = await resolve4('all.api.radio-browser.info');
        const hosts = await Promise.all((addresses || []).map(async (address) => {
          try { return await resolvePtr(address); } catch { return []; }
        }));
        discovered = hosts.flat().map((host) => { const value = String(host); return value.endsWith('.') ? value.slice(0, -1) : value; })
          .filter((host, index, list) => host.endsWith('.api.radio-browser.info') && list.indexOf(host) === index)
          .map((host) => 'https://' + host);
      } catch {}
    }
    if (!discovered.length) discovered = [FALLBACK_MIRROR];
    cachedMirrors = discovered.slice(0, 12);
    mirrorsExpires = Date.now() + 10 * 60 * 1000;
    return cachedMirrors.slice();
  }

  async function paceApi() {
    const now = Date.now();
    const wait = Math.max(0, nextApiRequestAt - now);
    nextApiRequestAt = Math.max(now, nextApiRequestAt) + minRequestIntervalMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  function cacheGet(key) {
    const item = responseCache.get(key);
    if (!item) return undefined;
    if (item.expires <= Date.now()) {
      responseCache.delete(key);
      return undefined;
    }
    return item.value;
  }

  function cacheSet(key, value, ttlMs) {
    responseCache.set(key, { value, expires: Date.now() + ttlMs });
    if (responseCache.size > 350) {
      const now = Date.now();
      for (const [key, item] of responseCache) if (item.expires <= now) responseCache.delete(key);
      while (responseCache.size > 300) responseCache.delete(responseCache.keys().next().value);
    }
  }

  function rateAllowed(req) {
    const key = getRemoteKey(req);
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.reset) {
      rateBuckets.set(key, { count: 1, reset: now + 60_000 });
      if (rateBuckets.size > 1000) {
        for (const [ip, item] of rateBuckets) if (item.reset <= now) rateBuckets.delete(ip);
      }
      return true;
    }
    bucket.count += 1;
    return bucket.count <= 180;
  }

  async function apiJson(apiPath, opts = {}) {
    const cacheKey = opts.cacheKey || '';
    const cached = cacheKey ? cacheGet(cacheKey) : undefined;
    if (cached !== undefined) return cached;

    const attempted = new Set();
    let lastError = null;
    // Discover current mirrors dynamically, then retry other mirrors on failures.
    for (let attempt = 0; attempt < 3; attempt++) {
      let mirrors = await getMirrors(attempt > 0 && !cachedMirrors);
      if (!mirrors.length) mirrors = [FALLBACK_MIRROR];
      const mirror = mirrors.find((item) => !attempted.has(item)) || FALLBACK_MIRROR;
      attempted.add(mirror);
      try {
        await paceApi();
        const { response } = await fetchUpstream(mirror + apiPath, {
          timeoutMs: 8000,
          maxRedirects: 3,
          userAgent: USER_AGENT,
          extraHeaders: { Accept: 'application/json' },
        });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch {}
          throw new Error('Radio directory returned HTTP ' + response.status);
        }
        const body = await readBody(response);
        let data;
        try { data = JSON.parse(body); }
        catch { throw new Error('Radio directory returned invalid JSON'); }
        if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
          throw new Error('Radio directory rejected the request');
        }
        if (cacheKey) cacheSet(cacheKey, data, opts.ttlMs || 45_000);
        return data;
      } catch (err) {
        lastError = err;
        if (attempt === 0 && mirrors.length === 1 && mirrors[0] === FALLBACK_MIRROR) break;
      }
    }
    const err = new Error('Public radio directory is temporarily unavailable');
    err.cause = lastError;
    err.statusCode = 502;
    throw err;
  }

  async function stations(req, res) {
    if (!rateAllowed(req)) return sendJson(req, res, 429, { error: 'Too many radio searches. Please wait a moment.' });
    try {
      const url = new URL(req.url, 'http://localhost');
      const params = url.searchParams;
      const q = safeString(params.get('q'), 120).toLowerCase();
      const countrycode = safeString(params.get('countrycode'), 2).toUpperCase();
      const language = safeString(params.get('language'), 60).toLowerCase();
      const tag = safeString(params.get('tag'), 60).toLowerCase();
      const codec = safeString(params.get('codec'), 24).toUpperCase();
      const orderIn = safeString(params.get('order'), 32);
      const order = VALID_ORDER.has(orderIn) ? orderIn : 'clickcount';
      const reverse = params.get('reverse') === 'false' ? 'false' : 'true';
      const limit = clampInt(params.get('limit'), 1, 100, 48);
      const offset = clampInt(params.get('offset'), 0, 1000000, 0);
      const config = radioSourceStore.loadSync(dataDir);
      const customMatches = config.stations.filter((station) => {
        if (station.enabled === false) return false;
        if (q && ![station.name, station.language, station.country, station.genre].join(' ').toLowerCase().includes(q)) return false;
        if (countrycode && countrycode !== String(station.countrycode || '').toUpperCase()) return false;
        if (language && !String(station.language || '').toLowerCase().includes(language)) return false;
        if (tag && !String(station.genre || '').toLowerCase().includes(tag)) return false;
        if (codec) return false;
        return true;
      }).map((station) => ({
        stationuuid: station.id,
        name: station.name,
        countrycode: /^[A-Z]{2}$/.test(String(station.countrycode || '').toUpperCase()) ? String(station.countrycode).toUpperCase() : '',
        country: station.country || '',
        language: station.language || '',
        languagecodes: '',
        tags: station.genre || '',
        favicon: '',
        homepage: station.homepage || '',
        codec: '',
        bitrate: 0,
        votes: 0,
        clickcount: 0,
        hls: /\.m3u8(?:$|[?#])/i.test(station.url),
        lastcheckok: true,
        custom: true,
      }));
      const customOnPage = customMatches.slice(offset, offset + limit);
      const remoteOffset = Math.max(0, offset - customMatches.length);
      const remoteLimit = Math.max(0, limit - customOnPage.length);
      let remote = [];
      if (config.directoryEnabled && remoteLimit > 0) {
        const query = new URLSearchParams({
          hidebroken: 'true',
          order,
          reverse,
          limit: String(remoteLimit),
          offset: String(remoteOffset),
        });
        if (params.get('q')) query.set('name', safeString(params.get('q'), 120));
        if (/^[A-Z]{2}$/.test(countrycode)) query.set('countrycode', countrycode);
        if (language) query.set('language', safeString(params.get('language'), 60));
        if (tag) query.set('tag', safeString(params.get('tag'), 60));
        if (codec) query.set('codec', codec);
        const data = await apiJson('/json/stations/search?' + query.toString(), {
          cacheKey: 'stations:' + query.toString(), ttlMs: 45_000,
        });
        if (!Array.isArray(data)) throw new Error('Unexpected radio directory response');
        remote = data.map(normalizeStation).filter(Boolean);
      }
      const stations = customOnPage.concat(remote);
      let nextOffset = null;
      if (config.directoryEnabled) {
        if (stations.length === limit) nextOffset = offset + stations.length;
        else if (customMatches.length > offset + customOnPage.length) nextOffset = offset + customOnPage.length;
      } else if (customMatches.length > offset + customOnPage.length) {
        nextOffset = offset + customOnPage.length;
      }
      sendJson(req, res, 200, {
        stations, limit, offset, nextOffset,
        source: config.directoryEnabled ? (customMatches.length ? 'Radio Browser + your stations' : 'Radio Browser') : 'Your radio stations',
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'Could not load radio stations' });
    }
  }
  async function listOptions(req, res) {
    if (!rateAllowed(req)) return sendJson(req, res, 429, { error: 'Too many radio requests. Please wait a moment.' });
    const url = new URL(req.url, 'http://localhost');
    const kind = url.searchParams.get('type');
    const config = {
      countries: { path: '/json/countrycodes?order=stationcount&reverse=true&limit=250', ttlMs: 6 * 60 * 60 * 1000 },
      languages: { path: '/json/languages?order=stationcount&reverse=true&limit=160', ttlMs: 6 * 60 * 60 * 1000 },
      tags: { path: '/json/tags?order=stationcount&reverse=true&limit=160', ttlMs: 60 * 60 * 1000 },
    }[kind];
    if (!config) return sendJson(req, res, 400, { error: 'type must be countries, languages, or tags' });
    try {
      const raw = await apiJson(config.path, { cacheKey: 'options:' + kind, ttlMs: config.ttlMs });
      if (!Array.isArray(raw)) throw new Error('Unexpected radio directory response');
      const values = raw.map((entry) => ({
        name: safeString(entry && entry.name, 80),
        iso_639: safeString(entry && entry.iso_639, 8),
        stationcount: clampInt(entry && entry.stationcount, 0, 2147483647, 0),
      })).filter((entry) => entry.name);
      sendJson(req, res, 200, { type: kind, values, source: 'Radio Browser' });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'Could not load radio filters' });
    }
  }

  function expireTickets() {
    const now = Date.now();
    for (const [token, ticket] of tickets) if (ticket.expires <= now) tickets.delete(token);
    while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
  }

  async function resolveStation(req, res, params) {
    if (!rateAllowed(req)) return sendJson(req, res, 429, { error: 'Too many radio requests. Please wait a moment.' });
    const uuid = safeString(params && params.uuid, 64);
    if (!UUID_RE.test(uuid)) return sendJson(req, res, 400, { error: 'Invalid station UUID' });
    try {
      // Custom stations are managed locally; all other UUIDs are resolved by Radio Browser.
      const custom = radioSourceStore.stationById(dataDir, uuid);
      let rawUrl;
      if (custom) {
        rawUrl = custom.url;
      } else {
        const config = radioSourceStore.loadSync(dataDir);
        if (!config.directoryEnabled) return sendJson(req, res, 404, { error: 'Radio Browser directory is disabled' });
        const result = await apiJson('/json/url/' + encodeURIComponent(uuid));
        rawUrl = result && result.url;
      }
      const stream = safeHttpUrl(rawUrl);
      if (!stream) return sendJson(req, res, 502, { error: 'This station has no usable HTTP(S) stream URL' });
      await validateUrl(stream.toString());
      expireTickets();
      const ticket = crypto.randomBytes(24).toString('base64url');
      tickets.set(ticket, { url: stream.toString(), expires: Date.now() + HTTP_TICKET_TTL });
      sendJson(req, res, 200, {
        stationuuid: uuid.toLowerCase(),
        url: stream.toString(),
        proxyUrl: '/api/radio/stream/' + ticket,
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'Could not resolve this radio station' });
    }
  }

  async function stream(req, res, params) {
    const ticket = safeString(params && params.ticket, 100);
    const item = tickets.get(ticket);
    if (!item || item.expires <= Date.now()) {
      tickets.delete(ticket);
      return sendJson(req, res, 404, { error: 'Radio stream ticket expired. Press Play again.' });
    }
    if (activeStreams >= MAX_STREAMS) return sendJson(req, res, 503, { error: 'The radio relay is busy. Retry in a moment.' });
    activeStreams += 1;
    let ended = false;
    const release = () => {
      if (ended) return;
      ended = true;
      activeStreams = Math.max(0, activeStreams - 1);
    };
    res.on('close', release);
    res.on('finish', release);
    try {
      const { response } = await fetchUpstream(item.url, {
        timeoutMs: 12_000,
        maxRedirects: 5,
        range: req.headers.range || null,
        userAgent: USER_AGENT,
        extraHeaders: { Accept: 'audio/*, application/octet-stream, */*;q=0.5' },
      });
      if (!response.ok && response.status !== 206) {
        try { await response.body?.cancel(); } catch {}
        release();
        if (!res.headersSent) return sendJson(req, res, 502, { error: 'The station stream returned HTTP ' + response.status });
        return res.end();
      }
      const contentType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
      if (!STREAM_TYPES.test(contentType)) {
        try { await response.body?.cancel(); } catch {}
        release();
        return sendJson(req, res, 415, { error: 'This station returned an unsupported media type' });
      }
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': response.headers.get('accept-ranges') || 'none',
        'Access-Control-Allow-Origin': '*',
        'X-Robots-Tag': 'noindex',
      };
      for (const key of ['content-length', 'content-range', 'icy-name', 'icy-br']) {
        const value = response.headers.get(key);
        if (value && /^[\x20-\x7e]+$/.test(value)) headers[key.split('-').map((p, i) => i ? p[0].toUpperCase() + p.slice(1) : p).join('-')] = value;
      }
      res.writeHead(response.status === 206 ? 206 : 200, headers);
      pipeStream(response, res, { stallMs: 45_000 });
    } catch (err) {
      release();
      if (!res.headersSent) sendJson(req, res, err.statusCode || 502, { error: err.message || 'Radio stream unavailable' });
      else res.end();
    }
  }

  return { stations, listOptions, resolveStation, stream, getMirrors, apiJson };
}

module.exports = { createRadioApi, normalizeStation, safeHttpUrl, UUID_RE, USER_AGENT, FALLBACK_MIRROR, MAX_STREAMS };
