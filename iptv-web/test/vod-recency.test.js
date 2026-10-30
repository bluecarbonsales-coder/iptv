'use strict';
// Pins the three defects behind "the movies did not update on time":
//   1. the Theatre advertised `pages` for the whole catalogue but served only its first 120
//      index rows, so every page past the fifth was empty;
//   2. ordering used the moment this box discovered a row, so the front page churned between
//      arbitrary harvest slices (and the Internet Archive, harvested last, held all of it);
//   3. new releases were only noticed by the hourly deep pass — refreshRecent() is the short
//      timer that sweeps each provider's newest pages, and trimItems() stops the index cap
//      from evicting records that are still being re-harvested.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../lib/api');
const { Catalog } = require('../lib/catalog');
const vod = require('../lib/vod');
const catalogLib = require('../lib/vod-catalog');
const library = require('../lib/media-library');

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body == null ? '' : String(body); },
  };
}

function tempDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

// A registry with no network reachable: refreshRecent() is driven by a stubbed vod.fetchJson.
function writeRegistry(dataDir, sources) {
  fs.writeFileSync(vod.registryPath(dataDir), JSON.stringify({
    version: 1, defaultsSeeded: true, defaultSourcesEnabled: true, allSourcesEnabledOnce: true, sources,
  }));
}

// A fresh health file so the API does not kick a real background catalogue refresh.
function writeFreshHealth(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'vod-provider-health.json'), JSON.stringify({
    version: 1, updatedAt: new Date().toISOString(), providers: [], totals: null, archive: null,
  }));
}

function seededItems() {
  const items = [];
  for (let i = 0; i < 150; i += 1) {
    items.push({
      sourceId: 'p1', vodId: 'm' + i, name: 'Movie ' + String(i).padStart(3, '0'), kind: 'movies',
      providerUpdatedAt: new Date(Date.UTC(2026, 9, 30, 0, i)).toISOString(),
    });
  }
  items.push({ sourceId: 'archive', vodId: 'old-clip', name: 'Archive Clip', kind: 'movies', year: '1955' });
  return items;
}

test('provider row timestamps are parsed to UTC, never to a guessed time', () => {
  assert.equal(vod.toIsoTime('2026-10-30 19:10:21'), '2026-10-30T11:10:21.000Z');
  assert.equal(vod.toIsoTime('2026/10/30 19:10'), '2026-10-30T11:10:00.000Z');
  assert.equal(vod.toIsoTime('2026-10-30'), '2026-10-29T16:00:00.000Z');
  assert.equal(vod.toIsoTime('1793075911'), new Date(1793075911000).toISOString());
  assert.equal(vod.toIsoTime('later'), null);
  assert.equal(vod.toIsoTime(''), null);
  assert.equal(vod.toIsoTime(null), null);
});

test('a harvested row carries the provider update time into the stored index record', () => {
  const source = { id: 's1', name: 'Provider One', api: 'https://p1.example/api.php/provide/vod', kind: 'all' };
  const item = vod.normalizeItem({
    vod_id: '9', vod_name: 'New Release', vod_time: '2026-10-30 19:10:21', type_name: '电影',
  }, source);
  assert.equal(item.providerUpdatedAt, '2026-10-30T11:10:21.000Z');
  const record = library.safeItem(catalogLib.catalogueItem(item, item.kind));
  assert.equal(record.providerUpdatedAt, '2026-10-30T11:10:21.000Z');
  assert.equal(record.searchText, undefined);
  assert.equal(library.safeItem({ name: 'No timestamp', sourceId: 's1', vodId: 'x' }).providerUpdatedAt, null);
  assert.equal(library.safeItem({ name: 'Bogus timestamp', sourceId: 's1', vodId: 'y', providerUpdatedAt: 'yesterday' }).providerUpdatedAt, null);
});

test('the index lists provider freshness first, open-license rows last, and pages past the fifth page', () => {
  const dataDir = tempDir('iptv-vod-recency-browse-');
  try {
    library.upsert(dataDir, seededItems());
    const first = catalogLib.browse(dataDir, { kind: 'movies', page: 1, limit: 24 });
    assert.equal(first.total, 151);
    assert.equal(first.pages, 7);
    assert.equal(first.items.length, 24);
    assert.equal(first.items[0].name, 'Movie 149'); // newest provider row, not the last discovery
    const sixth = catalogLib.browse(dataDir, { kind: 'movies', page: 6, limit: 24 });
    assert.equal(sixth.page, 6);
    assert.equal(sixth.items.length, 24);
    const seventh = catalogLib.browse(dataDir, { kind: 'movies', page: 7, limit: 24 });
    assert.equal(seventh.items.length, 7);
    assert.equal(seventh.items[seventh.items.length - 1].sourceId, 'archive'); // no provider time → last
    // a source filter still lists the open-license rows on their own
    const archiveOnly = catalogLib.browse(dataDir, { kind: 'movies', sourceId: 'archive', page: 1, limit: 24 });
    assert.equal(archiveOnly.total, 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the API serves the requested page of the index instead of an empty list', async () => {
  const dataDir = tempDir('iptv-vod-recency-api-');
  try {
    writeRegistry(dataDir, [{ id: 'p1', name: 'Provider One', api: 'https://p1.example/api.php/provide/vod', kind: 'all', enabled: true }]);
    writeFreshHealth(dataDir);
    library.upsert(dataDir, seededItems());
    const api = createApi(new Catalog(dataDir), async () => ({}), dataDir);
    const res = responseRecorder();
    await api.vodSearch({ headers: { 'accept-encoding': '' } }, res, {}, { type: 'movies', page: '6', limit: '24' });
    const body = JSON.parse(res.body);
    assert.equal(res.status, 200);
    assert.equal(body.catalog.source, 'index');
    assert.equal(body.total, 151);
    assert.equal(body.pages, 7);
    assert.equal(body.page, 6);
    assert.equal(body.items.length, 24);
    assert.equal(body.items[0].name, 'Movie 029');
    assert.equal(body.catalog.counts.movies, 151);
    // beyond the end the index clamps instead of answering with nothing
    const beyond = responseRecorder();
    await api.vodSearch({ headers: { 'accept-encoding': '' } }, beyond, {}, { type: 'movies', page: '99', limit: '24' });
    const beyondBody = JSON.parse(beyond.body);
    assert.equal(beyondBody.page, 7);
    assert.equal(beyondBody.items.length, 7);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('the recent sweep reads only the newest pages and records when it last ran', async () => {
  const dataDir = tempDir('iptv-vod-recency-recent-');
  const originalFetchJson = vod.fetchJson;
  try {
    writeRegistry(dataDir, [{ id: 'p1', name: 'Provider One', api: 'https://p1.example/api.php/provide/vod', kind: 'all', enabled: true }]);
    const calls = [];
    vod.fetchJson = async (url) => {
      calls.push(url);
      const params = new URL(url).searchParams;
      const action = params.get('ac');
      if (action === 'list' || action === 'class') return { code: 1, class: [{ type_id: 1, type_name: '电影' }] };
      const page = Number(params.get('pg') || 1);
      return {
        code: 1, page, pagecount: 900, total: 20000,
        list: [{
          vod_id: 'new-' + page, vod_name: 'Fresh Release ' + page, vod_time: '2026-10-30 19:10:21',
          type_name: '电影', vod_play_url: 'HD$https://cdn.example/fresh-' + page + '.m3u8',
        }],
      };
    };

    const summary = await catalogLib.refreshRecent({ dataDir, pages: 2 });
    assert.equal(summary.sources, 1);
    assert.equal(summary.pagesPerProvider, 2);
    assert.equal(summary.totals.harvested, 2);
    assert.equal(summary.totals.added, 2);
    assert.equal(summary.totals.providersOnline, 1);

    const pageCalls = calls.map((url) => new URL(url)).filter((url) => url.searchParams.get('pg'));
    const pageNumbers = [...new Set(pageCalls.map((url) => url.searchParams.get('pg')))].sort();
    assert.deepEqual(pageNumbers, ['1', '2']); // newest pages only — no deep-window pages
    assert.ok(pageCalls.every((url) => url.searchParams.get('h') === '24')); // the "updated in the last day" filter

    const stored = library.allItems(dataDir).find((item) => item.vodId === 'new-1');
    assert.equal(stored.providerUpdatedAt, '2026-10-30T11:10:21.000Z');
    const recent = catalogLib.readRecent(dataDir);
    assert.equal(recent.updatedAt, summary.updatedAt);
    assert.equal(recent.totals.added, 2);
    const state = catalogLib.state(dataDir);
    assert.equal(state.recent.updatedAt, summary.updatedAt);
    assert.ok(state.recent.ageMs !== null && state.recent.ageMs < 60000);

    // a second sweep re-sees the same rows: updated, never duplicated
    const again = await catalogLib.refreshRecent({ dataDir, pages: 2 });
    assert.equal(again.totals.added, 0);
    assert.equal(again.totals.updated, 2);
    assert.equal(library.allItems(dataDir).length, 2);
  } finally {
    vod.fetchJson = originalFetchJson;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the index cap drops the least recently seen records, not the re-harvested ones', () => {
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    items.push({ id: 'i' + i, key: 'k' + i, addedAt: stamp, lastSeenAt: stamp });
  }
  assert.deepEqual(library.trimItems(items, 4).map((item) => item.id), ['i6', 'i7', 'i8', 'i9']);
  assert.equal(library.trimItems(items, 20).length, 10);
  // discovered yesterday but re-harvested a minute ago beats discovered an hour ago
  const mixed = [
    { id: 'stale', key: 'stale', addedAt: '2026-10-30T10:00:00.000Z', lastSeenAt: '2026-10-30T10:00:00.000Z' },
    { id: 'revived', key: 'revived', addedAt: '2026-10-29T00:00:00.000Z', lastSeenAt: '2026-10-30T12:00:00.000Z' },
  ];
  assert.deepEqual(library.trimItems(mixed, 1).map((item) => item.id), ['revived']);
});
