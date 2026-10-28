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
const { withFileLock } = require('./registry-lock');
const { canonicalLanguages, fallbackLanguageForCountry } = require('./languages');

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

function saveSources(dataDir, sources, metadata = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = sourcesPath(dataDir);
  const tmp = target + '.tmp';
  let current = {};
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (raw && !Array.isArray(raw) && typeof raw === 'object') current = raw;
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify({ ...current, ...metadata, sources }, null, 2));
  fs.renameSync(tmp, target);
}

function ensureSourcesEnabled(dataDir) {
  const registry = loadSourcesSync(dataDir);
  if (registry.allSourcesEnabledOnce === true) return false;
  let changed = false;
  for (const source of registry.sources) {
    if (source.enabled !== true) {
      source.enabled = true;
      changed = true;
    }
  }
  saveSources(dataDir, registry.sources, { allSourcesEnabledOnce: true });
  return changed;
}

// Re-read + merge status fields only, so a source added while a background refresh is
// running is never clobbered by the child process writing an older list back.
async function mergeStatuses(dataDir, statuses) {
  return withFileLock(sourcesPath(dataDir) + '.lock', () => {
    const { sources } = loadSourcesSync(dataDir);
    for (const s of sources) {
      const st = (statuses || []).find((x) => x.id === s.id);
      if (st) Object.assign(s, st);
    }
    saveSources(dataDir, sources);
  });
}

function loadSourcesSync(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(sourcesPath(dataDir), 'utf8'));
    if (Array.isArray(raw)) return { sources: raw };
    if (Array.isArray(raw.sources)) return raw;
  } catch {}
  return { sources: [] };
}

function parseRegistrySources(config) {
  const items = [
    ...(config && Array.isArray(config.liveSources) ? config.liveSources : []),
    // TVBox directories use lives[] for M3U/plain-text broadcast lists.
    ...(config && Array.isArray(config.lives) ? config.lives : []),
  ];
  const result = new Map();
  for (const item of items) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url.trim()); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    const normalized = url.toString();
    let epg = null;
    if (typeof item.epg === 'string') {
      try {
        const epgUrl = new URL(item.epg.trim());
        if (['http:', 'https:'].includes(epgUrl.protocol) && !epgUrl.username && !epgUrl.password) {
          epgUrl.hash = '';
          epg = epgUrl.toString();
        }
      } catch {}
    }
    if (!result.has(normalized)) result.set(normalized, {
      name: String(item.name || url.hostname).trim().slice(0, 80) || url.hostname,
      url: normalized,
      epg,
    });
  }
  return [...result.values()];
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

function normalizePlaylistItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || !item.url) continue;
    let url = String(item.url).trim();
    let name = String(item.name || '').trim();
    // Accept common plain-text live lists like "Channel Name,https://stream.example/live.m3u8".
    const comma = /^(.*?),\s*(https?:\/\/\S+)$/i.exec(url);
    if (comma) {
      if (!name || name === url || name === url.split('/').pop()) name = comma[1].trim();
      url = comma[2].trim();
    }
    let parsed;
    try { parsed = new URL(url); } catch { continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ ...item, name: name || url.split('/').pop() || url, url });
  }
  return out;
}

async function fetchSource(src, opts = {}) {
  const { response } = await upstreamFetch(src.url, {
    timeoutMs: opts.timeoutMs || 30000,
    extraHeaders: { Accept: '*/*' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await bodyToString(response);
  if (isHlsManifest(text)) throw new Error('URL is a single HLS stream, not a playlist');
  const items = normalizePlaylistItems(parseM3U(text));
  if (!items.length) throw new Error('no valid HTTP(S) channels found in playlist');
  return items;
}

// tvg-country in third-party lists is sometimes a name ("Spain", "United States"), so only a
// bare two-letter code is trusted; anything else falls back to the source's own country.
function countryCode(value) {
  const code = String(value == null ? '' : value).split(/[;,]/)[0].trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

// Build catalogue channel records for one source's parsed items.
// Entries are grouped by group|name so a provider listing the same channel several
// times (mirrors/qualities) yields one channel with multiple playable sources.
function buildChannels(src, items) {
  const byKey = new Map();
  // Each item's own tags win; the source's configured language/country is the fallback. That
  // fallback is what makes the language tab usable for the curated lists (Pluto TV España,
  // Free-TV Türkiye, The Roku Channel …): their playlists carry no tvg-language, so without it
  // every one of their channels landed under "All languages" and the Spanish/Turkish/English
  // filters showed none of them.
  const srcLanguages = canonicalLanguages(src.language);
  const srcCountry = countryCode(src.country);
  for (const it of items) {
    const group = (it.group || '').trim() || null;
    const name = (it.name || '').trim() || 'Channel';
    const key = `${group || ''}|${name}`;
    let ch = byKey.get(key);
    if (!ch) {
      const itemLanguages = canonicalLanguages(it.language);
      const country = countryCode(it.country) || srcCountry;
      let languages = itemLanguages.length ? itemLanguages : srcLanguages.slice();
      if (!languages.length && country) {
        const guess = fallbackLanguageForCountry(country);
        if (guess) languages = [guess];
      }
      ch = {
        id: `x-${src.id}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`,
        name,
        alt: [],
        country,
        languages,
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

// Language facet for the merged catalogue: lib/refresh.js owns the vocabulary (codes, names,
// ordering by worldwide usage); merging a custom source only changes the counts. Rebuilding the
// facet from scratch here is what emptied the language filter — and with it the whole
// "browse channels by language" page.
function buildLanguageFacet(prevMeta, counts) {
  const known = Array.isArray(prevMeta.languages) ? prevMeta.languages : [];
  const facet = known
    .map((language) => Object.assign({}, language, { count: counts.get(language.code) || 0 }))
    .filter((language) => language.count > 0);
  const seen = new Set(facet.map((language) => language.code));
  for (const [code, count] of counts) {
    if (seen.has(code)) continue;
    facet.push({ code, name: code.toUpperCase(), count });
  }
  return facet;
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
  const previousBySource = new Map();
  for (const channel of catalogData.channels || []) {
    if (!channel.src) continue;
    if (!previousBySource.has(channel.src)) previousBySource.set(channel.src, []);
    previousBySource.get(channel.src).push(channel);
  }
  const failedSourceIds = new Set();
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
      failedSourceIds.add(s.id);
      s.lastError = String(err.message || err);
      s.lastUpdated = new Date().toISOString();
      log(`source failed: ${s.name}: ${s.lastError}`);
    }
    statuses.push({ id: s.id, lastCount: s.lastCount, lastStreamCount: s.lastStreamCount, lastUpdated: s.lastUpdated, lastError: s.lastError });
  }
  await mergeStatuses(dataDir, statuses);

  const kept = (catalogData.channels || []).filter((c) => !c.src);
  // Keep the last-known-good channels when a source is temporarily unreachable.
  // Disabled sources are intentionally excluded, while failed enabled sources remain usable.
  const stale = [...failedSourceIds].flatMap((id) => previousBySource.get(id) || []);
  const channels = kept.concat(stale, extra);
  // Every record must carry a language array: server.js treats a channel without one as a
  // missing language index and would re-refresh the catalogue on every check.
  for (const channel of channels) if (!Array.isArray(channel.languages)) channel.languages = [];
  channels.sort((a, b) => a.name.localeCompare(b.name));

  const cCount = new Map();
  const languageCount = new Map();
  const catCount = new Map();
  const qCount = new Map();
  let streamTotal = 0;
  const prevMeta = catalogData.meta || {};
  for (const c of channels) {
    if (c.country) cCount.set(c.country, (cCount.get(c.country) || 0) + 1);
    for (const language of c.languages || []) languageCount.set(language, (languageCount.get(language) || 0) + 1);
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
    languages: buildLanguageFacet(prevMeta, languageCount),
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
  ensureSourcesEnabled,
  mergeStatuses,
  newId,
  parseRegistrySources,
  normalizePlaylistItems,
  isHttpUrl,
  fetchSource,
  buildChannels,
  mergeInto,
  sourcesPath,
};
