'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vod = require('../lib/vod');
const DEFAULT_SOURCES = require('../lib/default-vod-sources');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('rejects unsupported schemes and embedded URL credentials', () => {
  assert.equal(vod.isHttpUrl('https://example.org/api.php/provide/vod'), true);
  assert.equal(vod.isHttpUrl('http://example.org/vod'), true);
  assert.equal(vod.isHttpUrl('file:///etc/passwd'), false);
  assert.equal(vod.isHttpUrl('https://user:pass@example.org/vod'), false);
  assert.throws(() => vod.normalizeApiUrl('javascript:alert(1)'), /HTTP\(S\)/);
});

test('builds Apple CMS API query parameters without losing the endpoint', () => {
  const url = vod.apiQuery({ api: 'https://catalog.example/api.php/provide/vod?token=x' }, { ac: 'videolist', wd: 'my film', pg: 2 });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/api.php/provide/vod');
  assert.equal(parsed.searchParams.get('token'), 'x');
  assert.equal(parsed.searchParams.get('ac'), 'videolist');
  assert.equal(parsed.searchParams.get('wd'), 'my film');
  assert.equal(parsed.searchParams.get('pg'), '2');
});

test('classifies movies, series, and anime using common source labels', () => {
  assert.equal(vod.classify({ type_name: '电影' }), 'movies');
  assert.equal(vod.classify({ type_name: '国产剧' }), 'series');
  assert.equal(vod.classify({ type_name: '日本动漫' }), 'anime');
  assert.equal(vod.classify({ type_name: 'Science' }), 'all');
});

test('filters obvious trailers and short clips without matching unrelated title words', () => {
  assert.equal(vod.isShortForm({ name: 'The Example Movie Official Trailer', category: '电影' }), true);
  assert.equal(vod.isShortForm({ name: 'City News', category: '短视频' }), true);
  assert.equal(vod.isShortForm({ name: 'Short Circuit', category: '科幻电影' }), false);
  assert.equal(vod.isShortForm({ name: 'A Feature Film', category: '电影' }), false);
});

test('parses alternate play-source groups and deduplicates episodes', () => {
  const items = vod.parseEpisodes({
    vod_play_from: 'line1$$$line2',
    vod_play_url: 'Ep 1$https://cdn.example/one.m3u8#Ep 2$https://cdn.example/two.m3u8$$$Alt$https://cdn.example/alt.m3u8',
  });
  assert.deepEqual(items, [
    { title: 'line1 · Ep 1', url: 'https://cdn.example/one.m3u8' },
    { title: 'line1 · Ep 2', url: 'https://cdn.example/two.m3u8' },
    { title: 'line2 · Alt', url: 'https://cdn.example/alt.m3u8' },
  ]);
});

test('normalizes MacCMS records without dropping provider context', () => {
  const source = { id: 'v123', name: 'Authorized films', api: 'https://catalog.example/api.php/provide/vod', kind: 'all', detail: null };
  const item = vod.normalizeItem({
    vod_id: 7,
    vod_name: 'Sample Animation',
    vod_pic: 'https://cdn.example/poster.jpg',
    type_name: '动漫',
    vod_year: '2024',
    vod_play_url: 'Episode 1$https://cdn.example/e1.m3u8',
  }, source);
  assert.equal(item.id, '7');
  assert.equal(item.sourceId, 'v123');
  assert.equal(item.kind, 'anime');
  assert.equal(item.episodes.length, 1);
  assert.equal(item.logo, 'https://cdn.example/poster.jpg');
});

test('imports LibreTV SourceList JSON with deduplication and preserves detail metadata', () => {
  const sources = vod.parseSourceList({
    name: 'Trusted list',
    version: 2,
    sources: [
      { name: 'Movies One', url: 'https://catalog.example/api.php/provide/vod', detail: 'https://catalog.example' },
      { name: 'Duplicate', url: 'https://catalog.example/api.php/provide/vod' },
      { name: 'Unsafe', url: 'file:///etc/passwd' },
      { name: 'Embedded credentials', url: 'https://user:pass@catalog.example/api.php/provide/vod' },
    ],
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, 'Movies One');
  assert.equal(sources[0].api, 'https://catalog.example/api.php/provide/vod');
  assert.equal(sources[0].detail, 'https://catalog.example/');
});

test('imports MoonTV api_site and compatible TVBox sites structures', () => {
  const moon = vod.parseSourceList({
    api_site: {
      filmhub: { name: 'Film Hub', api: 'https://one.example/api.php/provide/vod', detail: 'https://one.example' },
    },
  });
  assert.equal(moon.length, 1);
  assert.equal(moon[0].name, 'Film Hub');

  const tvbox = vod.parseSourceList({
    sites: [{ key: 'anime', name: 'Anime Catalog', api: 'https://anime.example/api.php/provide/vod' }],
  });
  assert.equal(tvbox.length, 1);
  assert.equal(tvbox[0].kind, 'all');
});

test('rejects config documents without compatible VOD APIs', () => {
  assert.throws(() => vod.parseSourceList({ foo: [] }), /No supported VOD APIs found/);
});

test('prefers the working Apple CMS list action discovered during probing', () => {
  assert.equal(vod.preferredListAction({ listAction: 'list' }), 'list');
  assert.equal(vod.preferredListAction({ listAction: 'videolist' }), 'videolist');
  assert.equal(vod.preferredListAction({}), 'videolist');
  assert.equal(vod.preferredListAction(null), 'videolist');
});


test('new VOD registries enable bundled provider sources', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-vod-defaults-'));
  try {
    assert.equal(DEFAULT_SOURCES.length, 33);
    assert.ok(DEFAULT_SOURCES.every((source) => source.enabled === true));
    assert.equal(vod.ensureDefaultSources(dataDir), true);
    const registry = vod.loadSourcesSync(dataDir);
    assert.equal(registry.sources.length, DEFAULT_SOURCES.length);
    assert.ok(registry.sources.every((source) => source.enabled === true));
    const persisted = JSON.parse(fs.readFileSync(vod.registryPath(dataDir), 'utf8'));
    assert.equal(persisted.defaultSourcesEnabled, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy installations enable the bundled providers once and preserve non-default source settings', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-vod-migration-'));
  try {
    const legacySources = [
      {
        id: 'seeded-disabled',
        name: DEFAULT_SOURCES[0].name,
        api: DEFAULT_SOURCES[0].api,
        kind: 'all',
        enabled: false,
        importedFrom: 'operator-provided initial list',
      },
      {
        id: 'custom-disabled',
        name: 'Custom disabled source',
        api: 'https://custom.example/api.php/provide/vod',
        kind: 'all',
        enabled: false,
        importedFrom: 'uploaded config',
      },
    ];
    fs.writeFileSync(vod.registryPath(dataDir), JSON.stringify({
      version: 1,
      defaultsSeeded: true,
      sources: legacySources,
    }, null, 2));

    assert.equal(vod.ensureDefaultSources(dataDir), true);
    let registry = vod.loadSourcesSync(dataDir);
    assert.equal(registry.sources.find((source) => source.id === 'seeded-disabled').enabled, true);
    assert.equal(registry.sources.find((source) => source.id === 'custom-disabled').enabled, false);

    // After the one-time migration, individual source toggles remain effective.
    registry.sources.find((source) => source.id === 'seeded-disabled').enabled = false;
    vod.saveSources(dataDir, registry.sources);
    assert.equal(vod.ensureDefaultSources(dataDir), false);
    registry = vod.loadSourcesSync(dataDir);
    assert.equal(registry.sources.find((source) => source.id === 'seeded-disabled').enabled, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
