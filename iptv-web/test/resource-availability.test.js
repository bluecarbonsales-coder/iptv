'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createResourceAvailability, classify, isHttpUrl } = require('../lib/resource-availability');

function res() {
  return { status: null, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = body == null ? '' : String(body); } };
}
const services = [
  { id: 'seedhub', name: 'SeedHub', url: 'https://seedhub.example/', category: 'Media resources' },
  { id: 'streambert', name: 'Streambert', url: 'https://streambert.example/', category: 'Media resources' },
  { id: 'local', name: 'Watch TV', url: '/watch.html', category: 'Media' },
];

test('resource URL validation accepts only credential-free HTTP(S)', () => {
  assert.equal(isHttpUrl('https://example.com/'), true);
  assert.equal(isHttpUrl('http://example.com:8080/'), true);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@example.com/', '', '//example.com/']) {
    assert.equal(isHttpUrl(url), false, url);
  }
});

test('availability classification distinguishes online, slow, restricted, missing, and offline', () => {
  assert.equal(classify(200, 20, 'now').status, 'online');
  assert.equal(classify(200, 1900, 'now').status, 'slow');
  assert.equal(classify(403, 20, 'now').status, 'restricted');
  assert.equal(classify(404, 20, 'now').status, 'not_found');
  assert.equal(classify(503, 20, 'now').status, 'offline');
});

test('probe reports every link and recommends the fastest available Media resources link', async () => {
  const availability = createResourceAvailability({
    getServices: () => services,
    refreshMs: 15000,
    timeoutMs: 500,
    now: (() => { let value = 1000; return () => value += 40; })(),
    upstreamFetch: async (url, options) => {
      assert.equal(options.method, 'HEAD');
      return { response: new Response(null, { status: url.includes('seedhub') ? 200 : 200 }) };
    },
  });
  await availability.startScan(true);
  const snapshot = availability.getSnapshot();
  assert.equal(snapshot.statuses.length, 3);
  assert.equal(snapshot.statuses.find((item) => item.id === 'local').status, 'local');
  assert.equal(snapshot.fastest.id, 'seedhub');
  assert.equal(snapshot.measuredFrom, 'application-server');
});

test('HEAD fallback uses a bounded range request if the origin rejects HEAD', async () => {
  const calls = [];
  const availability = createResourceAvailability({
    getServices: () => [services[0]],
    refreshMs: 15000,
    timeoutMs: 500,
    upstreamFetch: async (url, options) => {
      calls.push(options);
      return { response: new Response(null, { status: options.method === 'HEAD' ? 405 : 200 }) };
    },
  });
  await availability.startScan(true);
  const item = availability.getSnapshot().statuses.find((status) => status.id === 'seedhub');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'HEAD');
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].range, 'bytes=0-0');
  assert.equal(item.status, 'online');
});
