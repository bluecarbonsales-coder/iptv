'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceHealth } = require('../lib/source-health');
test('health snapshot counts available sources and reports relay latency without exposing URLs', async () => {
  const sources = {
    radio: [{ id: 'r1', name: 'Radio', url: 'https://radio.example/stream' }, { id: 'r-off', name: 'Disabled', url: 'https://radio.example/off', enabled: false }],
    iptv: [{ id: 'i1', name: 'Playlist', url: 'https://iptv.example/list.m3u' }],
    theatre: [{ id: 't1', name: 'VOD', api: 'https://vod.example/api.php' }],
  };
  let tick = 100;
  const monitor = createSourceHealth({ getSources: () => sources, now: () => ++tick, concurrency: 2,
    upstreamFetch: async url => ({ response: { status: url.includes('iptv.example') ? 503 : 200, body: { cancel: async () => {} } } }) });
  await monitor.startScan(true);
  const snapshot = monitor.getSnapshot();
  assert.equal(snapshot.summary.all.total, 4);
  assert.equal(snapshot.summary.all.enabled, 3);
  assert.equal(snapshot.summary.all.available, 2);
  assert.equal(snapshot.summary.all.unavailable, 1);
  assert.equal(snapshot.summary.radio.disabled, 1);
  const item = snapshot.statuses.find(s => s.id === 'i1');
  assert.equal(item.status, 'offline');
  assert.ok(Number.isFinite(item.proxyLatencyMs));
  assert.equal(Object.hasOwn(item, 'url'), false);
  assert.equal(snapshot.scanning, false);
});
test('source health falls back from HEAD to ranged GET and marks restricted responses', async () => {
  const methods = [];
  const monitor = createSourceHealth({ getSources: () => ({ radio: [{ id: 'r', name: 'R', url: 'https://restricted.example/stream' }], iptv: [], theatre: [] }),
    upstreamFetch: async (url, options) => { methods.push(options.method); return { response: { status: options.method === 'HEAD' ? 405 : 403, body: { cancel: async () => {} } } }; } });
  await monitor.startScan(true);
  const item = monitor.getSnapshot().statuses[0];
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(item.status, 'restricted');
  assert.equal(item.available, false);
});
