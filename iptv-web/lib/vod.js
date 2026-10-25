'use strict';
// User-managed video-on-demand provider registry compatible with Apple CMS / MacCMS APIs.
// Initial provider URLs are operator-supplied in default-vod-sources.js and can be managed in the UI.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEFAULT_SOURCES = require('./default-vod-sources');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');

const MAX_VOD_SOURCES = Math.max(1, Math.min(512, parseInt(process.env.MAX_VOD_SOURCES || '128', 10) || 128));
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const KINDS = new Set(['all', 'movies', 'series', 'anime', 'documentary']);

function registryPath(dataDir) {
  return path.join(dataDir, 'vod-sources.json');
}
function loadSourcesSync(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8'));
    if (Array.isArray(raw.sources)) return raw;
  } catch {}
  return { sources: [] };
}
function ensureDefaultSources(dataDir) {
  const target = registryPath(dataDir);
  let registry = { sources: [] };
  try {
    registry = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!Array.isArray(registry.sources)) registry.sources = [];
  } catch {}

  // One-time migration for installations that already seeded these operator-listed
  // providers while they were disabled. Run this only once so the operator can
  // disable individual providers again from the source manager afterward.
  if (registry.defaultsSeeded === true) {
    if (registry.defaultSourcesEnabled === true) return false;
    let changed = false;
    for (const source of registry.sources) {
      if (source.importedFrom === 'operator-provided initial list' && source.enabled !== true) {
        source.enabled = true;
        changed = true;
      }
    }
    saveSources(dataDir, registry.sources);
    return changed;
  }

  const now = new Date().toISOString();
  const existing = new Set(registry.sources.map((source) => source.api));
  const seeded = DEFAULT_SOURCES.slice(0, MAX_VOD_SOURCES).filter((source) => {
    try { return !existing.has(normalizeApiUrl(source.api)); } catch { return false; }
  }).map((source) => ({
    id: newId(),
    name: source.name,
    api: normalizeApiUrl(source.api),
    detail: null,
    kind: source.kind || 'all',
    enabled: source.enabled === true,
    addedAt: now,
    lastChecked: null,
    lastError: null,
    lastItemCount: null,
    listAction: 'videolist',
    importedFrom: 'operator-provided initial list',
  }));
  const additions = seeded.slice(0, Math.max(0, MAX_VOD_SOURCES - registry.sources.length));
  saveSources(dataDir, registry.sources.concat(additions));
  return additions.length > 0;
}
function saveSources(dataDir, sources) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = registryPath(dataDir);
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({
    version: 1,
    defaultsSeeded: true,
    defaultSourcesEnabled: true,
    sources,
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}
function newId() {
  return 'v' + crypto.randomBytes(5).toString('hex');
}
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  } catch {
    return false;
  }
}
function normalizeApiUrl(value) {
  const raw = String(value || '').trim();
  if (!isHttpUrl(raw)) throw Object.assign(new Error('API URL must be HTTP(S) and must not include embedded credentials'), { statusCode: 400 });
  const u = new URL(raw);
  u.hash = '';
  return u.toString();
}
function apiQuery(source, params) {
  const url = new URL(source.api);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}
async function fetchJson(url, timeoutMs = 15000) {
  const { response } = await upstreamFetch(url, {
    timeoutMs,
    extraHeaders: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
  });
  if (!response.ok) throw Object.assign(new Error('Provider returned HTTP ' + response.status), { statusCode: 502 });
  const len = Number(response.headers.get('content-length') || 0);
  if (len > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Provider response is too large'), { statusCode: 502 });
  const text = await bodyToString(response);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Provider response is too large'), { statusCode: 502 });
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw Object.assign(new Error('Provider did not return valid JSON; use an Apple CMS / MacCMS VOD API URL'), { statusCode: 502 });
  }
}
function listFrom(payload) {
  const candidates = [payload && payload.list, payload && payload.data && payload.data.list, payload && payload.data, payload && payload.results];
  for (const item of candidates) {
    if (Array.isArray(item)) return item;
    if (item && Array.isArray(item.list)) return item.list;
  }
  return [];
}
function text(value) {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function classify(item) {
  const category = text([item.type_name, item.typeName, item.vod_class, item.category, item.type].filter(Boolean).join(' ')).toLowerCase();
  if (/动漫|动画|anime|animation|cartoon|donghua/.test(category)) return 'anime';
  if (/纪录片|纪录|documentary|nonfiction/.test(category)) return 'documentary';
  if (/电视剧|剧集|连续剧|国产剧|欧美剧|泰剧|短剧|美剧|韩剧|日剧|港剧|台剧|日韩剧|华语剧|综艺|series|tv show|drama|variety/.test(category)) return 'series';
  if (/电影|动作片|喜剧片|爱情片|科幻片|恐怖片|战争片|犯罪片|悬疑片|剧情片|惊悚片|冒险片|movie|film|feature/.test(category)) return 'movies';
  return 'all';
}

function isShortForm(item = {}) {
  const category = text([item.category, item.type_name, item.typeName, item.vod_class, item.type].filter(Boolean).join(' '));
  const title = text([item.name, item.vod_name, item.title].filter(Boolean).join(' '));
  const remarks = text([item.remarks, item.vod_remarks, item.state].filter(Boolean).join(' '));
  const titleText = title.toLowerCase();
  const remarksText = remarks.toLowerCase();
  // Provider lists frequently mix a movie catalogue with trailers, promos and
  // standalone social clips. Keep those out of the feature catalogue.
  if (/(短视频|短片|预告片|片花|花絮|宣传片|视频剪辑|高光集锦|音乐视频|movie trailer|video clip|shorts? category)/i.test(category)) return true;
  if (/\b(?:official\s+)?(?:movie\s+)?(?:trailer|teaser|promo(?:tional)?|preview|clip|highlights?|music video|behind the scenes|making of)\b/i.test(title)) return true;
  if (/\bshort[ _-]+(?:film|movie|video)\b/i.test(title)) return true;
  if (/\b(?:trailer|teaser|promo(?:tional)?|preview|clip|music video)\b/i.test(remarksText)) return true;
  return false;
}
function parseEpisodes(item) {
  const urlFields = String(item.vod_play_url || item.play_url || item.playUrl || '');
  const sourceNames = String(item.vod_play_from || item.play_from || '').split('$$$');
  const sourceGroups = urlFields.split('$$$');
  const episodes = [];
  for (let groupIndex = 0; groupIndex < sourceGroups.length; groupIndex++) {
    const sourceName = text(sourceNames[groupIndex] || '');
    const group = sourceGroups[groupIndex];
    for (const raw of group.split('#')) {
      const row = raw.trim();
      if (!row) continue;
      const sep = row.indexOf('$');
      const title = sep >= 0 ? text(row.slice(0, sep)) : 'Play';
      const url = (sep >= 0 ? row.slice(sep + 1) : row).trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const label = [sourceName, title || ('Episode ' + (episodes.length + 1))].filter(Boolean).join(' · ');
      if (!episodes.some((episode) => episode.url === url)) episodes.push({ title: label, url });
      if (episodes.length >= 500) return episodes;
    }
  }
  return episodes;
}
function normalizeItem(item, source) {
  const id = String(item.vod_id ?? item.id ?? item.id_vod ?? '').trim();
  const name = text(item.vod_name || item.name || item.title);
  if (!id || !name) return null;
  const kind = source.kind === 'all' ? classify(item) : source.kind;
  return {
    id,
    key: source.id + ':' + id,
    sourceId: source.id,
    sourceName: source.name,
    name,
    logo: text(item.vod_pic || item.pic || item.poster || item.cover) || null,
    overview: text(item.vod_blurb || item.vod_content || item.content || item.overview).slice(0, 1200),
    year: text(item.vod_year || item.year || ''),
    category: text(item.type_name || item.vod_class || item.category || ''),
    remarks: text(item.vod_remarks || item.remarks || item.state || ''),
    kind,
    detailUrl: source.detail || null,
    episodes: parseEpisodes(item),
    vod: true,
  };
}
function providerStatus(payload) {
  if (payload && payload.code !== undefined && Number(payload.code) < 0) {
    throw Object.assign(new Error(text(payload.msg || 'Provider rejected the request') || 'Provider rejected the request'), { statusCode: 502 });
  }
}
async function probeSource(source) {
  // TVBox aggregation includes providers that are only reachable with ac=list;
  // try both documented Apple CMS / MacCMS list actions during initial validation.
  let lastError = null;
  for (const action of ['videolist', 'list']) {
    try {
      const payload = await fetchJson(apiQuery(source, { ac: action, pg: 1 }));
      providerStatus(payload);
      const supported = Array.isArray(payload) ||
        (payload && Array.isArray(payload.list)) ||
        (payload && payload.data && (Array.isArray(payload.data.list) || Array.isArray(payload.data)));
      if (!supported) throw Object.assign(new Error('Response is not a supported Apple CMS / MacCMS catalog'), { statusCode: 400 });
      source.listAction = action;
      return { count: listFrom(payload).length, action };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || Object.assign(new Error('Provider did not support Apple CMS / MacCMS list actions'), { statusCode: 400 });
}
function preferredListAction(source) {
  return source && source.listAction === 'list' ? 'list' : 'videolist';
}
async function searchSource(source, query, page) {
  const action = preferredListAction(source);
  let payload;
  try {
    payload = await fetchJson(apiQuery(source, { ac: action, wd: query, pg: page }));
    providerStatus(payload);
    const hasResultShape = Array.isArray(payload) ||
      (payload && Array.isArray(payload.list)) ||
      (payload && payload.data && (Array.isArray(payload.data.list) || Array.isArray(payload.data)));
    if (!hasResultShape) throw new Error('Provider returned an unsupported VOD list response');
    if (action === 'list' && String(query || '').trim() && listFrom(payload).length === 0) {
      // Some providers accept ac=list for probing but require ac=videolist for search.
      payload = await fetchJson(apiQuery(source, { ac: 'videolist', wd: query, pg: page }));
      providerStatus(payload);
    }
  } catch (err) {
    if (action !== 'list') throw err;
    // Prefer the standard video-list action for providers whose list action only supports
    // a broad catalog listing without search pagination.
    payload = await fetchJson(apiQuery(source, { ac: 'videolist', wd: query, pg: page }));
    providerStatus(payload);
  }
  return listFrom(payload).map((row) => normalizeItem(row, source)).filter(Boolean);
}
async function getDetail(source, vodId) {
  let lastError;
  const actions = source.listAction === 'list' ? ['detail', 'list', 'videolist'] : ['detail', 'videolist', 'list'];
  for (const mode of actions) {
    try {
      const payload = await fetchJson(apiQuery(source, { ac: mode, ids: vodId, wd: '' }));
      providerStatus(payload);
      const rows = listFrom(payload).map((row) => normalizeItem(row, source)).filter(Boolean);
      const item = rows.find((row) => row.id === String(vodId)) || rows[0];
      if (item && item.episodes.length) return item;
      if (item) lastError = new Error('Provider returned no playable episodes');
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error('Video details were not found'), { statusCode: 404 });
}

function parseSourceList(payload) {
  const raw = [];
  if (payload && Array.isArray(payload.sources)) {
    for (const source of payload.sources) raw.push({
      name: source && source.name,
      api: source && (source.url || source.api),
      detail: source && source.detail,
      kind: source && source.kind,
    });
  }
  if (payload && payload.api_site && typeof payload.api_site === 'object' && !Array.isArray(payload.api_site)) {
    for (const [key, source] of Object.entries(payload.api_site)) raw.push({
      name: source && source.name || key,
      api: source && (source.api || source.url),
      detail: source && source.detail,
      kind: source && source.kind,
    });
  }
  if (payload && Array.isArray(payload.sites)) {
    for (const source of payload.sites) raw.push({
      name: source && source.name || source && source.key,
      api: source && (source.api || source.url),
      detail: source && source.detail,
      kind: source && source.kind,
    });
  }

  const found = new Map();
  for (const item of raw) {
    if (!item || !item.api || !isHttpUrl(String(item.api).trim())) continue;
    let api;
    try { api = normalizeApiUrl(item.api); } catch { continue; }
    const name = text(item.name || new URL(api).hostname).slice(0, 80) || 'VOD provider';
    let detail = null;
    if (item.detail && isHttpUrl(String(item.detail).trim())) {
      try { detail = normalizeApiUrl(item.detail); } catch {}
    }
    const kind = KINDS.has(item.kind) ? item.kind : 'all';
    if (!found.has(api)) found.set(api, { name, api, detail, kind });
  }
  if (!found.size) {
    throw Object.assign(new Error('No supported VOD APIs found. Expected LibreTV SourceList JSON (sources), MoonTV config.json (api_site), or a TVBox-style sites array using Apple CMS / MacCMS APIs.'), { statusCode: 400 });
  }
  return [...found.values()];
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|password|passwd|api[_-]?key|access[_-]?key|access[_-]?token|auth|signature|credential|session|jwt)/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    return '';
  }
}
function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    // Source endpoints can contain provider credentials in query parameters.
    // Redact secrets in API responses just as we do for detail/import URLs.
    api: redactUrl(source.api),
    apiHost: (() => { try { return new URL(source.api).host; } catch { return null; } })(),
    detail: source.detail ? redactUrl(source.detail) : null,
    kind: source.kind,
    enabled: source.enabled !== false,
    addedAt: source.addedAt || null,
    lastChecked: source.lastChecked || null,
    lastError: source.lastError || null,
    lastItemCount: source.lastItemCount ?? null,
    listAction: source.listAction || 'videolist',
    importedFrom: source.importedFrom ? (() => { try { const u = new URL(source.importedFrom); return u.origin + u.pathname + (u.search ? '?[query-redacted]' : ''); } catch { return 'uploaded config'; } })() : null,
  };
}
module.exports = {
  MAX_VOD_SOURCES, KINDS, registryPath, loadSourcesSync, saveSources, ensureDefaultSources,
  newId, isHttpUrl, normalizeApiUrl, apiQuery, fetchJson, listFrom, classify, isShortForm,
  parseEpisodes, normalizeItem, probeSource, preferredListAction, searchSource, getDetail, parseSourceList, redactUrl, publicSource,
};
