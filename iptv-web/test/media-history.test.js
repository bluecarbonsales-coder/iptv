'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaHistory, MAX_ITEMS } = require('../lib/media-history');

test('media history persists watch and listen entries and keeps only safe metadata', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-media-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createMediaHistory(dataDir);
  history.add({ type: 'iptv', id: 'cctv-1', title: 'CCTV-1', country: 'China', countryCode: 'cn', url: 'https://private.example/stream' });
  history.add({ type: 'radio', id: 'radio-uuid', title: 'China Radio', country: 'China', countryCode: 'CN' });
  const restarted = createMediaHistory(dataDir);
  assert.equal(restarted.list().length, 2);
  assert.equal(restarted.list('iptv')[0].title, 'CCTV-1');
  assert.equal(restarted.list('radio')[0].id, 'radio-uuid');
  assert.equal(Object.hasOwn(restarted.list()[0], 'url'), false);
  assert.equal((fs.statSync(path.join(dataDir, 'media-history.json')).mode & 0o077), 0);
});

test('media history deduplicates by media ID and bounds retained entries', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-media-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createMediaHistory(dataDir);
  history.add({ type: 'iptv', id: 'same', title: 'Old title' });
  history.add({ type: 'iptv', id: 'same', title: 'Updated title' });
  assert.equal(history.list('iptv').length, 1);
  assert.equal(history.list('iptv')[0].title, 'Updated title');
  for (let i = 0; i < MAX_ITEMS + 10; i++) history.add({ type: 'radio', id: 'station-' + i, title: 'Station ' + i });
  assert.equal(history.list().length, MAX_ITEMS);
  assert.equal(history.list()[0].id, 'station-' + (MAX_ITEMS + 9));
});

test('media history validates types and can clear one category', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-media-history-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const history = createMediaHistory(dataDir);
  assert.throws(() => history.add({ type: 'other', id: 'x', title: 'X' }), { statusCode: 400 });
  history.add({ type: 'iptv', id: 'tv', title: 'TV' });
  history.add({ type: 'radio', id: 'fm', title: 'FM' });
  history.clear('radio');
  assert.equal(history.list('radio').length, 0);
  assert.equal(history.list('iptv').length, 1);
});
