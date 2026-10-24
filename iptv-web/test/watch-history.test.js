'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryStore } = require('../lib/watch-history');

test('watch and search history survives store recreation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const visitorId = '12345678-1234-4234-8234-123456789abc';
  let store = createHistoryStore(dir);
  store.record(visitorId, { event: 'search', query: 'documentaries' });
  store.record(visitorId, {
    event: 'watch',
    item: { id: 'vod-src-7', sourceId: 'src', vodId: '7', name: 'Example film' },
    episodeIndex: 2,
    episodeTitle: 'Episode 3',
  });
  store = createHistoryStore(dir);
  const records = store.get(visitorId);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, 'watch');
  assert.equal(records[0].item.name, 'Example film');
  assert.equal(records[0].episodeIndex, 2);
  assert.equal(records[1].event, 'search');
  assert.equal(records[1].query, 'documentaries');
});

test('history rejects malformed visitor identifiers and invalid events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-history-invalid-'));
  try {
    const store = createHistoryStore(dir);
    assert.throws(() => store.get('bad'), /invalid visitor history id/);
    assert.throws(() => store.record('12345678-1234-4234-8234-123456789abc', { event: 'other' }), /event must be search or watch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
