'use strict';
// Server-side custom playlist sources ("channels providers").
//
// Any M3U/M3U8 URL on the web can be added as a source (data/sources.json, persisted
// in the docker volume). Every catalogue refresh re-downloads each enabled source and
// merges its channels into the main catalogue, so they become first-class channels:
// searchable, filterable, favouritable, exported, and renewed on every update.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseM3U, isHlsManifest } = require('./m3u');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');

const MAX_SOURCES = parseInt(process.env.MAX_SOURCES || '64', 10);

function sourcesPath(dataDir) {
  return path.join(dataDir, 'sources.json');
}

async function loadSources(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(sourcesPath(dataDir), 'utf8'));
    if (Array.isArray(raw)) return { sources: raw }; // legacy flat array
    if (Array.isArray(raw.sources)) return raw;
  } catch {}
  return { sources: [] };
}

function saveSources(dataDir, sources) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = sourcesPath(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sources }, null, 2));
  fs.renameSync(tmp, sourcesPath(dataDir));
}

// Re-read + merge status fields only, so a source added while a background refresh is
// running is never clobbered by the child process writing an older list back.
function mergeStatuses(dataDir, statuses) {
  const { sources } = loadSourcesSync(dataDir);
  for (const s of sources) {
    const st = (statuses || []).find((x) => x.id === s.id);
    if (st) Object.assign(s, st);
  }
  saveSources(dataDir, sources);
}

function loadSourcesSync(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(sourcesPath(dataDir), 'utf8'));
    if (Array.isArray(raw)) return { sources: raw };
    if (Array.isArray(raw.sources)) return raw;
  } catch {}
  return { sources: [] };
}

function newId() {
  return 's' + crypto.randomBytes(5).toString('hex');
}

function isHttpUrl(u) {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

async function fetchSource(src) {
  const { response } = await upstreamFetch(src.url, { timeoutMs: 30000, extraHeaders: { Accept: '*/*' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await bodyToString(response);
  if (isHlsManifest(text)) throw new Error('URL is a single HLS stream, not a playlist');
  const items = parseM3U(text);
  if (!items.length) throw new Error('no channels found in playlist');
  return items;
}

// Build catalogue channel records for one source's parsed items.
// Entries are grouped by group|name so a provider listing the same channel several
// times (mirrors/qualities) yields one channel with multiple playable sources.
function buildChannels(src, items) {
  const byKey = new Map();
  for (const it of items) {
    const group = (it.group || '').trim() || null;
    const name = (it.name || '').trim() || 'Channel';
    const key = `${group || ''}|${name}`;
    let ch = byKey.get(key);
    if (!ch) {
      ch = {
        id: `x-${src.id}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`,
        name,
        alt: [],
        country: (it.country || '').split(/[;,]/)[0].toUpperCase() || null,
        cats: group ? [group] : [],
        nsfw: false,
        network: null,
        website: null,
        launched: null,
        closed: null,
        logo: it.logo || null,
        streams: [],
        ns: 0,
        src: src.id,
        srcName: src.name,
      };
      byKey.set(key, ch);
    }
    if (it.url && !ch.streams.some((s) => s.u === it.url)) {
      ch.streams.push({ u: it.url, q: null, r: it.referrer || null, ua: it.userAgent || null, l: [], f: null });
    }
  }
  const channels = [...byKey.values()].filter((c) => c.streams.length);
  for (const c of channels) c.ns = c.streams.length;
  return channels;
}

// Merge custom-source channels into a catalogue ({channels, meta}).
// - drops previously merged source channels (anything with a `src` field)
// - fetches every enabled source (errors are recorded, never fatal)
// - recomputes meta counts; custom group names stay out of the category facet list
//   (they would flood the chips) but remain searchable and visible on cards.
async function mergeInto(catalogData, dataDir, log = () => {}) {
  const { sources } = loadSourcesSync(dataDir);
  const statuses = [];
  const extra = [];
  for (const s of sources) {
    if (!s.enabled) {
      statuses.push({ id: s.id });
      continue;
    }
    try {
      const t0 = Date.now();
      const items = await fetchSource(s);
      const channels = buildChannels(s, items);
      extra.push(...channels);
      s.lastCount = channels.length;
      s.lastStreamCount = channels.reduce((a, c) => a + c.streams.length, 0);
      s.lastUpdated = new Date().toISOString();
      s.lastError = null;
      log(`source ok: ${s.name} (${channels.length} channels, ${Date.now() - t0}ms)`);
    } catch (err) {
      s.lastError = String(err.message || err);
      s.lastUpdated = new Date().toISOString();
      log(`source failed: ${s.name}: ${s.lastError}`);
    }
    statuses.push({ id: s.id, lastCount: s.lastCount, lastStreamCount: s.lastStreamCount, lastUpdated: s.lastUpdated, lastError: s.lastError });
  }
  mergeStatuses(dataDir, statuses);

  const kept = (catalogData.channels || []).filter((c) => !c.src);
  const channels = kept.concat(extra);
  channels.sort((a, b) => a.name.localeCompare(b.name));

  const cCount = new Map();
  const catCount = new Map();
  const qCount = new Map();
  let streamTotal = 0;
  const prevMeta = catalogData.meta || {};
  for (const c of channels) {
    if (c.country) cCount.set(c.country, (cCount.get(c.country) || 0) + 1);
    if (!c.src) for (const cat of c.cats || []) catCount.set(cat, (catCount.get(cat) || 0) + 1);
    for (const s of c.streams || []) {
      streamTotal++;
      if (s.q) qCount.set(s.q, (qCount.get(s.q) || 0) + 1);
    }
  }

  const meta = {
    updated: new Date().toISOString(),
    total: channels.length,
    streams: streamTotal,
    countries: [...cCount.entries()].map(([code, count]) => {
      const old = (prevMeta.countries || []).find((x) => x.code === code);
      return { code, name: (old || {}).name || code, flag: (old || {}).flag || '', count };
    }).sort((a, b) => a.name.localeCompare(b.name)),
    categories: (prevMeta.categories || [])
      .map((c) => ({ ...c, count: catCount.get(c.id) || 0 }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count),
    qualities: [...qCount.entries()].map(([q, count]) => ({ q, count })).sort((a, b) => b.count - a.count),
    sources: loadSourcesSync(dataDir).sources.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled !== false,
      count: s.lastCount || 0,
      streams: s.lastStreamCount || 0,
      updated: s.lastUpdated || null,
      error: s.lastError || null,
    })),
  };
  return { channels, meta };
}

module.exports = {
  MAX_SOURCES,
  loadSources,
  loadSourcesSync,
  saveSources,
  mergeStatuses,
  newId,
  isHttpUrl,
  fetchSource,
  buildChannels,
  mergeInto,
  sourcesPath,
};
