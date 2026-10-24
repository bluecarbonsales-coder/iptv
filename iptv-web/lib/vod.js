'use strict';
// User-managed video-on-demand provider registry compatible with Apple CMS / MacCMS APIs.
// Providers must be supplied by the operator; no third-party feed is bundled by default.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');

const MAX_VOD_SOURCES = Math.max(1, Math.min(64, parseInt(process.env.MAX_VOD_SOURCES || '24', 10) || 24));
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const KINDS = new Set(['all', 'movies', 'series', 'anime']);

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
function saveSources(dataDir, sources) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = registryPath(dataDir);
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, sources }, null, 2), { mode: 0o600 });
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
  if (/电视剧|剧集|连续剧|国产剧|欧美剧|泰剧|短剧|美剧|韩剧|日剧|港剧|台剧|日韩剧|华语剧|综艺|纪录片|纪录|series|tv show|drama|documentary|variety/.test(category)) return 'series';
  if (/电影|动作片|喜剧片|爱情片|科幻片|恐怖片|战争片|犯罪片|悬疑片|剧情片|惊悚片|冒险片|movie|film|feature/.test(category)) return 'movies';
  return 'all';
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
  // Probe with a normal list request; providers may return an empty list on a new catalog.
  const payload = await fetchJson(apiQuery(source, { ac: 'videolist', pg: 1 }));
  providerStatus(payload);
  if (!Array.isArray(payload) && !(payload && (Array.isArray(payload.list) || payload.data))) {
    throw Object.assign(new Error('Response is not a supported Apple CMS / MacCMS catalog'), { statusCode: 400 });
  }
  return { count: listFrom(payload).length };
}
async function searchSource(source, query, page) {
  const payload = await fetchJson(apiQuery(source, { ac: 'videolist', wd: query, pg: page }));
  providerStatus(payload);
  return listFrom(payload).map((row) => normalizeItem(row, source)).filter(Boolean);
}
async function getDetail(source, vodId) {
  let lastError;
  for (const mode of ['detail', 'videolist']) {
    try {
      const payload = await fetchJson(apiQuery(source, { ac: mode, ids: vodId, wd: '' }));
      providerStatus(payload);
      const item = listFrom(payload).map((row) => normalizeItem(row, source)).find((row) => row && row.id === String(vodId)) || listFrom(payload).map((row) => normalizeItem(row, source)).find(Boolean);
      if (item && item.episodes.length) return item;
      if (item) lastError = new Error('Provider returned no playable episodes');
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error('Video details were not found'), { statusCode: 404 });
}
function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    api: source.api,
    kind: source.kind,
    enabled: source.enabled !== false,
    addedAt: source.addedAt || null,
    lastChecked: source.lastChecked || null,
    lastError: source.lastError || null,
  };
}
module.exports = {
  MAX_VOD_SOURCES, KINDS, registryPath, loadSourcesSync, saveSources,
  newId, isHttpUrl, normalizeApiUrl, apiQuery, fetchJson, listFrom, classify,
  parseEpisodes, normalizeItem, probeSource, searchSource, getDetail, publicSource,
};
