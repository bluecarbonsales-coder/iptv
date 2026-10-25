'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const library = require('../lib/media-library');

test('media library persists items, deduplicates by source identity, and searches metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-library-'));
  try {
    const first = library.upsert(dir, [
      { id: 'vod-src-1', sourceId: 'src', vodId: '1', name: 'The Example', kind: 'movies', year: '2024', overview: 'Space adventure' },
      { id: 'vod-src-2', sourceId: 'src', vodId: '2', name: 'Another Film', kind: 'movies' },
    ]);
    assert.deepEqual({ added: first.added, updated: first.updated, total: first.total }, { added: 2, updated: 0, total: 2 });
    const again = library.upsert(dir, [{ id: 'vod-src-1', sourceId: 'src', vodId: '1', name: 'The Example', kind: 'movies', year: '2024', overview: 'Updated overview' }]);
    assert.deepEqual({ added: again.added, updated: again.updated, total: again.total }, { added: 0, updated: 1, total: 2 });
    const found = library.search(dir, { q: 'space adventure', type: 'movies' });
    assert.equal(found.total, 1);
    assert.equal(found.items[0].name, 'The Example');
    assert.equal(library.stats(dir).total, 2);
    assert.equal(library.remove(dir, found.items[0].id), true);
    assert.equal(library.stats(dir).total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('media library rejects nameless records and invalid direct URLs', () => {
  assert.equal(library.safeItem({ url: 'javascript:alert(1)' }), null);
  const item = library.safeItem({ name: 'Saved channel', url: 'javascript:alert(1)', kind: 'channel' });
  assert.ok(item);
  assert.equal(item.url, null);
});
