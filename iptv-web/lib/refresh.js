'use strict';
// Fetch the iptv-org API dump and compile it into data/catalog.json + data/meta.json.
//
//   node lib/refresh.js             # download from the first reachable source
//   node lib/refresh.js --src=...   # build from an existing directory of api json files
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { QUALITY_HEIGHT } = require('./catalog');
const { canonicalLanguage } = require('./languages');
// This file also runs as a child process (`node lib/refresh.js`), so it needs the same
// IPv4 preference the server applies — otherwise the download of the iptv-org dump can hit
// the same dual-stack failure inside the container.
require('./net-preferences').applyNetworkPreferences();

const FILES = ['channels.json', 'streams.json', 'logos.json', 'categories.json', 'countries.json', 'languages.json', 'feeds.json'];

const LANGUAGE_PRIORITY = [
  'eng', 'zho', 'hin', 'spa', 'ara', 'fra', 'ben', 'por', 'ind', 'urd', 'rus',
  'deu', 'jpn', 'pan', 'jav', 'kor', 'vie', 'mar', 'tel', 'tam', 'tur', 'ita',
  'fas', 'pol', 'ukr', 'nld', 'tha', 'swa', 'nep', 'ell', 'swe', 'hau', 'amh', 'yor',
];
const LANGUAGE_ALIASES = { chi: 'zho', cmn: 'zho', fre: 'fra', ger: 'deu', dut: 'nld', per: 'fas', gre: 'ell', cze: 'ces', rum: 'ron', slo: 'slk', alb: 'sqi', may: 'msa', bur: 'mya', tib: 'bod', ice: 'isl', wel: 'cym' };
function languageRank(code) {
  const normalized = String(code || '').trim().toLowerCase();
  const canonical = LANGUAGE_ALIASES[normalized] || normalized;
  const index = LANGUAGE_PRIORITY.indexOf(canonical);
  return index < 0 ? LANGUAGE_PRIORITY.length : index;
}

const SOURCES = [
  'https://iptv-org.github.io/api/',
  'https://gh-proxy.org/https://raw.githubusercontent.com/iptv-org/api/gh-pages/',
  'https://ghproxy.net/https://raw.githubusercontent.com/iptv-org/api/gh-pages/',
];

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// No per-channel cap: a handful of channels carry >100 sources and every one of them is a
// fallback for the player, so keep them all (MAX_STREAMS_PER_CHANNEL=25 to re-impose one).
const MAX_STREAMS_PER_CHANNEL = parseInt(process.env.MAX_STREAMS_PER_CHANNEL || '0', 10) || Infinity;

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

async function download(srcDir) {
  const out = {};
  for (const f of FILES) {
    const url = srcDir + f;
    const res = await fetch(url, { headers: { 'User-Agent': 'iptv-web/1.0' } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    out[f] = JSON.parse(buf.toString('utf8'));
    log(`  ${f.padEnd(16)} ${(buf.length / 1048576).toFixed(2)} MB`);
  }
  return out;
}

function pickLogo(logosForChannel) {
  const inUse = logosForChannel.filter((l) => l.in_use !== false);
  const pool = inUse.length ? inUse : logosForChannel;
  let best = null;
  let bestScore = -1;
  for (const l of pool) {
    const score = (l.width || 0) * (l.height || 0) + (l.in_use ? 1e6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best ? best.url : null;
}

function build(api, stats) {
  const countries = new Map((api['countries.json'] || []).map((c) => [c.code, c]));
  const categories = new Map((api['categories.json'] || []).map((c) => [c.id, c]));
  const languages = new Map((api['languages.json'] || []).map((language) => [String(language.code || '').toLowerCase(), language]));

  // Channel -> language index. iptv-org moved the mapping out of channels.json: each feed
  // carries the languages it broadcasts in, so a channel's languages are the union of its
  // feeds' languages (older dumps still ship ch.languages; fall back to the country's
  // official languages when a channel has neither).
  const langsByChannel = new Map();
  for (const feed of api['feeds.json'] || []) {
    if (!feed || !feed.channel) continue;
    const set = langsByChannel.get(feed.channel) || new Set();
    for (const code of Array.isArray(feed.languages) ? feed.languages : []) {
      const trimmed = String(code || '').trim().toLowerCase();
      if (trimmed) set.add(trimmed);
    }
    langsByChannel.set(feed.channel, set);
  }
  const countryLanguages = new Map();
  for (const [code, country] of countries) {
    countryLanguages.set(code, (Array.isArray(country.languages) ? country.languages : [])
      .map((language) => String(language || '').trim().toLowerCase())
      .filter(Boolean));
  }
  const channelLanguages = (channel) => {
    const fromFeeds = [...(langsByChannel.get(channel.id) || [])];
    const explicit = (Array.isArray(channel.languages) ? channel.languages : [])
      .map((code) => String(code || '').trim().toLowerCase());
    const pool = fromFeeds.length ? fromFeeds : explicit.length ? explicit : countryLanguages.get(channel.country) || [];
    // Canonicalise before the facet is built: a feed carrying the 639-2/B form ("FRE", "GER",
    // "DUT", "JAP", "CZE", "ARM") otherwise becomes a second entry next to the 639-3 code and
    // a language filter misses half of that language's channels.
    const out = [];
    for (const code of pool) {
      const canonical = canonicalLanguage(code);
      if (canonical && !out.includes(canonical)) out.push(canonical);
    }
    return out;
  };

  const logosByChannel = new Map();
  for (const l of api['logos.json'] || []) {
    if (!l.channel) continue;
    if (!logosByChannel.has(l.channel)) logosByChannel.set(l.channel, []);
    logosByChannel.get(l.channel).push(l);
  }

  const streamsByChannel = new Map();
  let orphanStreams = 0;
  for (const s of api['streams.json'] || []) {
    if (!s.channel || !s.url) {
      orphanStreams++;
      continue;
    }
    if (!streamsByChannel.has(s.channel)) streamsByChannel.set(s.channel, []);
    streamsByChannel.get(s.channel).push(s);
  }

  const channels = [];
  let droppedNoStream = 0;

  // Every channel that still has at least one stream is kept — no adult / category / country
  // filtering happens at build time. iptv-org removes the streams of channels it blocks
  // (DMCA, NSFW), so those drop out through the stream test alone; anything still listed here
  // is watchable and is exposed with `nsfw` + labels so the UI can filter client-side.
  for (const ch of api['channels.json'] || []) {
    const raw = streamsByChannel.get(ch.id) || [];
    if (!raw.length) {
      droppedNoStream++;
      continue;
    }
    const seen = new Set();
    const streams = [];
    for (const s of raw) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      streams.push({
        u: s.url,
        q: s.quality || null,
        r: s.referrer || null,
        ua: s.user_agent || null,
        l: s.labels || [],
        f: s.feed || null,
      });
    }
    streams.sort((a, b) => QUALITY_HEIGHT(b.q) - QUALITY_HEIGHT(a.q));
    const capped = Number.isFinite(MAX_STREAMS_PER_CHANNEL) ? streams.slice(0, MAX_STREAMS_PER_CHANNEL) : streams;

    channels.push({
      id: ch.id,
      name: ch.name,
      alt: (ch.alt_names || []).slice(0, 4),
      country: ch.country || null,
      languages: channelLanguages(ch),
      cats: ch.categories || [],
      nsfw: !!ch.is_nsfw,
      network: ch.network || null,
      website: ch.website || null,
      launched: ch.launched || null,
      closed: ch.closed || null,
      logo: pickLogo(logosByChannel.get(ch.id) || []),
      streams: capped,
      ns: streams.length,
    });
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));

  // meta: only the facets that actually occur, with counts
  const cCount = new Map();
  const languageCount = new Map();
  const catCount = new Map();
  const qCount = new Map();
  let streamTotal = 0;
  for (const c of channels) {
    if (c.country) cCount.set(c.country, (cCount.get(c.country) || 0) + 1);
    for (const language of c.languages || []) languageCount.set(language, (languageCount.get(language) || 0) + 1);
    for (const cat of c.cats) catCount.set(cat, (catCount.get(cat) || 0) + 1);
    for (const s of c.streams) {
      streamTotal++;
      if (s.q) qCount.set(s.q, (qCount.get(s.q) || 0) + 1);
    }
  }

  const meta = {
    updated: new Date().toISOString(),
    total: channels.length,
    streams: streamTotal,
    countries: [...cCount.entries()]
      .map(([code, count]) => ({
        code,
        name: (countries.get(code) || {}).name || code,
        flag: (countries.get(code) || {}).flag || '',
        count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    languages: [...languageCount.entries()]
      .map(([code, count]) => ({
        code,
        name: (languages.get(code) || {}).name || code.toUpperCase(),
        count,
        rank: languageRank(code),
      }))
      .sort((a, b) => a.rank - b.rank || b.count - a.count || a.name.localeCompare(b.name))
      .map(({ rank, ...language }) => language),
    categories: [...catCount.entries()]
      .map(([id, count]) => ({ id, name: (categories.get(id) || {}).name || id, count }))
      .sort((a, b) => b.count - a.count),
    qualities: [...qCount.entries()].map(([q, count]) => ({ q, count })).sort((a, b) => b.count - a.count),
  };

  stats.channels = channels.length;
  stats.streams = streamTotal;
  stats.nsfw = channels.filter((c) => c.nsfw).length;
  stats.droppedNoStream = droppedNoStream;
  stats.orphanStreams = orphanStreams;
  stats.cappedChannels = channels.filter((c) => c.ns > c.streams.length).length;

  return { channels, meta };
}

async function main() {
  const srcArg = process.argv.find((a) => a.startsWith('--src='));
  let api;
  const stats = {};

  if (srcArg) {
    const dir = srcArg.split('=')[1].replace(/\/?$/, '/');
    log(`building from local dir ${dir}`);
    api = {};
    for (const f of FILES) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) {
        log(`  skip missing ${f}`);
        api[f] = [];
        continue;
      }
      api[f] = JSON.parse(fs.readFileSync(p, 'utf8'));
      log(`  ${f.padEnd(16)} ${(fs.statSync(p).size / 1048576).toFixed(2)} MB`);
    }
  } else {
    let lastErr;
    for (const src of SOURCES) {
      try {
        log(`downloading from ${src}`);
        api = await download(src);
        stats.source = src;
        break;
      } catch (err) {
        lastErr = err;
        log(`  failed: ${err.message}`);
      }
    }
    if (!api) throw lastErr || new Error('all sources failed');
  }

  let { channels, meta } = build(api, stats);
  // Keep a previous custom-source snapshot available so a failed refresh can retain its last-known-good channels.
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
    channels = channels.concat((previous.channels || []).filter((channel) => channel.src));
  } catch {}
  // Merge user-managed M3U sources into the catalogue without replacing the upstream base data.
  const merged = await require('./sources').mergeInto({ channels, meta }, DATA_DIR, log);
  channels = merged.channels;
  meta = merged.meta;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({ meta, channels });
  const out = path.join(DATA_DIR, 'catalog.json');
  fs.writeFileSync(out, payload);
  fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  // pre-compressed copy the server streams straight to the browser
  const gz = zlib.gzipSync(Buffer.from(payload), { level: 9 });
  fs.writeFileSync(out + '.gz', gz);

  log('built catalog', JSON.stringify(stats));
  log(`wrote ${out} (${(payload.length / 1048576).toFixed(2)} MB, gz ${(gz.length / 1048576).toFixed(2)} MB)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('refresh failed:', err.message);
    process.exit(1);
  });
}

module.exports = { build, SOURCES, FILES };
