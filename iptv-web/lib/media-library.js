'use strict';
// Persistent, dependency-free media catalog for discovered VOD items and saved direct URLs.
// The channel catalogue remains in catalog.json; this index complements it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = Math.max(1000, Math.min(250000, Number.parseInt(process.env.MEDIA_LIBRARY_MAX_ITEMS || '50000', 10) || 50000));
const TYPES = new Set(['all', 'movies', 'series', 'anime', 'documentary', 'channel', 'video']);

function filePath(dataDir) { return path.join(dataDir, 'media-library.json'); }
function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function safeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || raw.title || '').trim().slice(0, 240);
  if (!name) return null;
  const sourceId = String(raw.sourceId || 'saved').slice(0, 120);
  const vodId = String(raw.vodId || raw.id || '').slice(0, 240);
  const url = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url.slice(0, 3000) : null;
  const type = TYPES.has(raw.kind) ? raw.kind : (raw.vod ? 'video' : 'channel');
  const id = String(raw.id || crypto.createHash('sha256').update([sourceId, vodId || url || normalize(name)].join('|')).digest('hex').slice(0, 32)).slice(0, 240);
  return {
    id, key: sourceId + ':' + (vodId || url || normalize(name)), sourceId, sourceName: String(raw.sourceName || (sourceId === 'saved' ? 'Saved manually' : sourceId)).slice(0, 120),
    vodId: vodId || null, name, title: name,
    logo: typeof (raw.logo || raw.poster) === 'string' ? String(raw.logo || raw.poster).slice(0, 2000) : null,
    overview: String(raw.overview || raw.description || '').slice(0, 2000),
    year: String(raw.year || '').slice(0, 12), category: String(raw.category || (Array.isArray(raw.cats) ? raw.cats[0] : '') || '').slice(0, 120),
    kind: type, url, detailUrl: typeof raw.detailUrl === 'string' ? raw.detailUrl.slice(0, 3000) : null,
    episodes: Array.isArray(raw.episodes) ? raw.episodes.slice(0, 500).map((ep, i) => ({ title: String(ep.title || ('Episode ' + (i + 1))).slice(0, 240), url: String(ep.url || '').slice(0, 3000) })).filter(ep => /^https?:\/\//i.test(ep.url)) : [],
    pageUrl: typeof raw.pageUrl === 'string' ? raw.pageUrl.slice(0, 2000) : null,
    licenseUrl: typeof raw.licenseUrl === 'string' ? raw.licenseUrl.slice(0, 2000) : null,
    addedAt: raw.addedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), searchText: normalize([name, raw.overview, raw.year, raw.category, raw.sourceName, ...(raw.cats || [])].join(' ')),
  };
}
function read(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(dataDir), 'utf8'));
    return { version: 1, items: Array.isArray(data.items) ? data.items.filter(x => x && x.id && x.name) : [], updatedAt: data.updatedAt || null };
  } catch { return { version: 1, items: [], updatedAt: null }; }
}
function write(dataDir, data) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = filePath(dataDir), temp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: data.items.slice(0, MAX_ITEMS) }), { mode: 0o600 });
  fs.renameSync(temp, target);
}
function upsert(dataDir, rawItems) {
  const data = read(dataDir);
  const byKey = new Map(data.items.map(item => [item.key || item.id, item]));
  let added = 0, updated = 0;
  for (const raw of (Array.isArray(rawItems) ? rawItems : [rawItems])) {
    const item = safeItem(raw);
    if (!item) continue;
    const prior = byKey.get(item.key);
    if (prior) {
      byKey.set(item.key, { ...prior, ...item, addedAt: prior.addedAt || item.addedAt });
      updated++;
    } else {
      byKey.set(item.key, item);
      added++;
    }
  }
  const items = [...byKey.values()].slice(-MAX_ITEMS);
  write(dataDir, { items });
  return { added, updated, total: items.length };
}
function search(dataDir, params = {}) {
  const data = read(dataDir);
  const q = normalize(params.q || '');
  const type = TYPES.has(params.type) ? params.type : 'all';
  const limit = Math.max(1, Math.min(100, Number.parseInt(params.limit, 10) || 50));
  const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
  let hits = data.items.filter(item => (type === 'all' || item.kind === type || (type === 'movies' && item.kind === 'video')) && (!q || q.split(' ').every(word => (item.searchText || normalize([item.name, item.overview, item.year, item.category].join(' '))).includes(word))));
  hits.sort((a, b) => String(b.lastSeenAt || b.updatedAt || '').localeCompare(String(a.lastSeenAt || a.updatedAt || '')) || a.name.localeCompare(b.name));
  return { total: hits.length, page, limit, pages: Math.max(1, Math.ceil(hits.length / limit)), items: hits.slice((page - 1) * limit, page * limit).map(({ searchText, ...item }) => item), updatedAt: data.updatedAt };
}
function remove(dataDir, id) {
  const data = read(dataDir);
  const next = data.items.filter(item => item.id !== id);
  if (next.length === data.items.length) return false;
  write(dataDir, { items: next });
  return true;
}
function stats(dataDir) {
  const items = read(dataDir).items;
  const byType = {};
  for (const item of items) byType[item.kind] = (byType[item.kind] || 0) + 1;
  return { total: items.length, byType, updatedAt: read(dataDir).updatedAt };
}
module.exports = { filePath, upsert, search, remove, stats, safeItem, MAX_ITEMS };
