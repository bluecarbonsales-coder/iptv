'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-f0-9-]{16,64}$/i;
const MAX_ITEMS = 500;

function createHistoryStore(dataDir) {
  const file = path.join(dataDir, 'watch-history.json');
  function readAll() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function saveAll(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function validId(id) { return typeof id === 'string' && ID_RE.test(id); }
  function get(id) {
    if (!validId(id)) throw Object.assign(new Error('invalid visitor history id'), { statusCode: 400 });
    const all = readAll();
    const now = Date.now();
    const records = Array.isArray(all[id]) ? all[id] : [];
    const fresh = records.filter((r) => r && Number.isFinite(Date.parse(r.updatedAt)) && now - Date.parse(r.updatedAt) < 365 * 86400000);
    if (fresh.length !== records.length) { all[id] = fresh; saveAll(all); }
    return fresh;
  }
  function record(id, body) {
    if (!validId(id)) throw Object.assign(new Error('invalid visitor history id'), { statusCode: 400 });
    if (!body || !['search', 'watch'].includes(body.event)) throw Object.assign(new Error('event must be search or watch'), { statusCode: 400 });
    const all = readAll();
    const records = Array.isArray(all[id]) ? all[id] : [];
    const now = new Date().toISOString();
    if (body.event === 'search') {
      const query = String(body.query || '').trim().slice(0, 120);
      if (!query) return { ok: true, saved: false };
      records.unshift({ id: crypto.randomUUID(), event: 'search', query, updatedAt: now });
    } else {
      const item = body.item;
      if (!item || typeof item !== 'object' || !item.name || !item.sourceId || !item.vodId) {
        throw Object.assign(new Error('watch event requires title and source identifiers'), { statusCode: 400 });
      }
      const entry = {
        id: crypto.randomUUID(), event: 'watch',
        item: {
          id: String(item.id || '').slice(0, 240),
          sourceId: String(item.sourceId).slice(0, 120),
          vodId: String(item.vodId).slice(0, 240),
          name: String(item.name).slice(0, 240),
          logo: typeof item.logo === 'string' ? item.logo.slice(0, 1500) : null,
          year: String(item.year || '').slice(0, 12),
          kind: String(item.kind || 'all').slice(0, 32),
          overview: String(item.overview || '').slice(0, 1200),
          cats: Array.isArray(item.cats) ? item.cats.slice(0, 8).map(x => String(x).slice(0, 100)) : [],
          remarks: String(item.remarks || '').slice(0, 120),
        },
        episodeIndex: Math.max(0, Math.min(499, Number.parseInt(body.episodeIndex, 10) || 0)),
        episodeTitle: String(body.episodeTitle || '').slice(0, 240),
        updatedAt: now,
      };
      const index = records.findIndex((r) => r.event === 'watch' && r.item && r.item.sourceId === entry.item.sourceId && r.item.vodId === entry.item.vodId);
      if (index >= 0) records.splice(index, 1);
      records.unshift(entry);
    }
    all[id] = records.slice(0, MAX_ITEMS);
    saveAll(all);
    return { ok: true, saved: true, count: all[id].length };
  }
  return { get, record };
}
module.exports = { createHistoryStore };
