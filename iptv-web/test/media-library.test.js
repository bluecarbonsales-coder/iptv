'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const library = require('../lib/media-library');

test('persists, deduplicates, and searches media metadata and episode titles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-library-'));
  try {
    const first = library.upsert(dir, [
      { id: 'vod-src-1', sourceId: 'src', vodId: '1', name: 'The Example', kind: 'series', year: '2024', overview: 'Space adventure', episodes: [{ title: 'The Lost Signal', url: 'https://example.org/episode.m3u8' }] },
      { id: 'vod-src-2', sourceId: 'src', vodId: '2', name: 'Another Film', kind: 'movies' },
    ]);
    assert.deepEqual({ added: first.added, updated: first.updated, total: first.total }, { added: 2, updated: 0, total: 2 });
    assert.equal(library.search(dir, { q: 'space adventure', type: 'series' }).total, 1);
    const again = library.upsert(dir, [{ id: 'vod-src-1', sourceId: 'src', vodId: '1', name: 'The Example', kind: 'series', year: '2024', overview: 'Updated overview', episodes: [{ title: 'The Lost Signal', url: 'https://example.org/episode.m3u8' }] }]);
    assert.deepEqual({ added: again.added, updated: again.updated, total: again.total }, { added: 0, updated: 1, total: 2 });
    assert.equal(library.search(dir, { q: 'updated overview', type: 'series' }).total, 1);
    assert.equal(library.search(dir, { q: 'lost signal', type: 'series' }).total, 1);
    assert.equal(library.stats(dir).total, 2);
    assert.equal(library.remove(dir, library.search(dir, { q: 'the example', type: 'series' }).items[0].id), true);
    assert.equal(library.stats(dir).total, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejects nameless records and invalid direct URLs', () => {
  assert.equal(library.safeItem({ url: 'javascript:alert(1)' }), null);
  const item = library.safeItem({ name: 'Saved channel', url: 'javascript:alert(1)', kind: 'channel' });
  assert.ok(item);
  assert.equal(item.url, null);
});

test('bounds pagination and stores data in a restart-persistent JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-library-'));
  try {
    library.upsert(dir, { name: 'Persistent title', sourceId: 'test', vodId: 'one', kind: 'movies' });
    assert.ok(fs.existsSync(path.join(dir, 'media-library.json')));
    assert.equal(library.search(dir, { q: 'persistent', limit: 1000 }).limit, 100);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
