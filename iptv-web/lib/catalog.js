'use strict';
// In-memory channel catalog: loaded once, queried with filter + ranked search.
const fs = require('fs');
const path = require('path');
const { normalize } = require('./util');

const QUALITY_HEIGHT = (q) => {
  const m = /(\d{3,4})/.exec(String(q || ''));
  return m ? parseInt(m[1], 10) : 0;
};

class Catalog {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.channels = [];
    this.meta = { countries: [], categories: [], qualities: [], total: 0, streams: 0, updated: null };
    this.byId = new Map();
    this.loadedAt = 0;
  }

  get ready() {
    return this.channels.length > 0;
  }

  load() {
    const catPath = path.join(this.dataDir, 'catalog.json');
    const metaPath = path.join(this.dataDir, 'meta.json');
    if (!fs.existsSync(catPath)) {
      this.channels = [];
      return false;
    }
    const raw = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    this.channels = raw.channels || [];
    this.meta = Object.assign(this.meta, raw.meta || {});
    this.byId = new Map();
    for (const c of this.channels) {
      c._s = normalize([c.name, ...(c.alt || []), c.id.replace(/[._]/g, ' ')].join(' '));
      c._best = (c.streams || []).reduce((a, s) => Math.max(a, QUALITY_HEIGHT(s.q)), 0);
      this.byId.set(c.id, c);
    }
    this.loadedAt = Date.now();
    return true;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  static funnel(params) {
    const csv = (v) =>
      String(v || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      q: normalize(params.q || ''),
      countries: csv(params.country).map((c) => c.toUpperCase()),
      categories: csv(params.category).map((c) => c.toLowerCase()),
      minQuality: parseInt(params.minQuality, 10) || 0,
      // Nothing is hidden unless the caller asks: safe=1 drops adult channels, safe=0/absent
      // returns the whole catalogue.
      hideAdult: params.safe === '1' || params.safe === 'true',
      adultOnly: params.adultOnly === '1',
      hasLogo: params.hasLogo === '1',
      ids: csv(params.ids),
    };
  }

  match(c, f) {
    if (f.hideAdult && c.nsfw) return false;
    if (f.adultOnly && !c.nsfw) return false;
    if (f.countries.length && !f.countries.includes(c.country)) return false;
    if (f.categories.length && !f.categories.some((x) => (c.cats || []).includes(x))) return false;
    if (f.minQuality && c._best < f.minQuality) return false;
    if (f.hasLogo && !c.logo) return false;
    if (f.ids.length && !f.ids.includes(c.id)) return false;
    if (f.q) {
      const words = f.q.split(' ').filter(Boolean);
      if (!words.every((w) => c._s.includes(w))) return false;
    }
    return true;
  }

  score(c, q) {
    if (!q) return 0;
    const name = normalize(c.name);
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) return 2;
    if (name.includes(q)) return 3;
    return 4;
  }

  query(params = {}) {
    const f = Catalog.funnel(params);
    const limit = Math.min(200, Math.max(1, parseInt(params.limit, 10) || 60));
    const page = Math.max(1, parseInt(params.page, 10) || 1);
    const sort = params.sort || (f.q ? 'relevance' : 'name');

    let hits = this.channels.filter((c) => this.match(c, f));
    hits = sortHits(hits, f, (a, b) => this.score(a, f.q) - this.score(b, f.q), sort);

    const total = hits.length;
    const start = (page - 1) * limit;
    const slice = hits.slice(start, start + limit);
    return {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      items: slice.map((c) => Catalog.card(c)),
    };
  }

  // Every match (used by the M3U exporter, which must not page).
  filterAll(params = {}, max = 25000) {
    const f = Catalog.funnel(params);
    const hits = this.channels.filter((c) => this.match(c, f));
    return sortHits(hits, f, (a, b) => this.score(a, f.q) - this.score(b, f.q), params.sort).slice(0, max);
  }

  static card(c) {
    const labels = [...new Set((c.streams || []).flatMap((s) => s.l || []))];
    return {
      id: c.id,
      name: c.name,
      country: c.country,
      cats: c.cats || [],
      logo: c.logo || null,
      q: bestQualityLabel(c),
      streams: (c.streams || []).length,
      nsfw: !!c.nsfw,
      labels,
      closed: c.closed || null,
    };
  }

  static detail(c) {
    return Object.assign(Catalog.card(c), {
      alt: c.alt || [],
      website: c.website || null,
      network: c.network || null,
      launched: c.launched || null,
      streamsList: c.streams || [],
    });
  }

  countryName(code) {
    const hit = (this.meta.countries || []).find((x) => x.code === code);
    return hit ? hit.name : code;
  }
}

function bestQualityLabel(c) {
  const qs = (c.streams || []).map((s) => s.q).filter(Boolean);
  if (!qs.length) return null;
  qs.sort((a, b) => QUALITY_HEIGHT(b) - QUALITY_HEIGHT(a));
  return qs[0];
}

function sortHits(hits, f, byScore, sort) {
  if (f.q) return hits.sort((a, b) => byScore(a, b) || a.name.localeCompare(b.name));
  if (sort === 'quality') return hits.sort((a, b) => b._best - a._best || a.name.localeCompare(b.name));
  if (sort === 'streams') return hits.sort((a, b) => b.streams.length - a.streams.length || a.name.localeCompare(b.name));
  return hits.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { Catalog, QUALITY_HEIGHT };
