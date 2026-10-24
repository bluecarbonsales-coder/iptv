'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vod = require('../lib/vod');

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
