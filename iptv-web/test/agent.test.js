'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesToken, safeUrlSummary } = require('../lib/agent');
const vod = require('../lib/vod');
const { registryUrls } = require('../lib/automation');

test('agent token comparison accepts exact token and rejects different lengths', () => {
  assert.equal(matchesToken('long-random-secret', 'long-random-secret'), true);
  assert.equal(matchesToken('long-random-secret', 'long-random-secreT'), false);
  assert.equal(matchesToken('short', 'long-random-secret'), false);
  assert.equal(matchesToken(undefined, 'long-random-secret'), false);
  assert.equal(matchesToken('secret', ''), false);
});

test('agent status URLs omit query credentials', () => {
  assert.equal(
    safeUrlSummary('https://provider.example/api.php?api_key=secret&cat=vod'),
    'https://provider.example/api.php?[query-redacted]'
  );
  assert.equal(safeUrlSummary('not a url'), '[invalid URL]');
});

test('provider source summaries redact common query secrets', () => {
  const source = vod.publicSource({
    id: 'v1',
    name: 'Example',
    api: 'https://provider.example/api?token=top-secret&kind=vod',
    kind: 'all',
    enabled: true,
  });
  assert.equal(source.api.includes('top-secret'), false);
  assert.equal(source.api.includes('REDACTED'), true);
  assert.equal(source.apiHost, 'provider.example');
});

test('source registry URLs are read from explicit operator configuration only', () => {
  const previous = process.env.VOD_SOURCE_LIST_URLS;
  process.env.VOD_SOURCE_LIST_URLS = 'https://trusted.example/list.json,not-a-url\nhttps://another.example/config.json';
  try {
    assert.deepEqual(registryUrls(), [
      'https://trusted.example/list.json',
      'https://another.example/config.json',
    ]);
  } finally {
    if (previous === undefined) delete process.env.VOD_SOURCE_LIST_URLS;
    else process.env.VOD_SOURCE_LIST_URLS = previous;
  }
});
