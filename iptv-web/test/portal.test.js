'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeServiceUrl, validateService, matchesToken, DEFAULT_SERVICES, MAX_SERVICES } = require('../lib/portal');

test('portal accepts safe absolute URLs and same-site relative service paths', () => {
  assert.equal(isSafeServiceUrl('https://example.com'), true);
  assert.equal(isSafeServiceUrl('http://example.com:8080/app?q=1'), true);
  assert.equal(isSafeServiceUrl('/watch.html'), true);
  assert.equal(isSafeServiceUrl('/watch.html?view=all'), true);
});

test('portal rejects script URLs, protocol-relative paths, credentials and path traversal', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    '//evil.example/path',
    '/../../admin',
    'https://user:password@example.com',
    'file:///etc/passwd',
    'https://example.com\\\\@evil.example',
    '',
  ]) assert.equal(isSafeServiceUrl(url), false, url);
});

test('service validation normalizes fields and applies length bounds', () => {
  const result = validateService({ name: ' Example ', url: 'https://example.com', category: 'Tools', icon: '↗', description: ' Open it ' });
  assert.equal(result.name, 'Example');
  assert.equal(result.description, 'Open it');
  assert.equal(result.category, 'Tools');
  assert.equal(result.featured, false);
  assert.throws(() => validateService({ name: '', url: 'https://example.com' }), /name/);
  assert.throws(() => validateService({ name: 'Example', url: 'javascript:alert(1)' }), /URL/);
  assert.throws(() => validateService({ name: 'x'.repeat(81), url: 'https://example.com' }), /name/);
});

test('management token comparison checks exact values and defaults are extensible', () => {
  assert.equal(matchesToken('long-random-secret', 'long-random-secret'), true);
  assert.equal(matchesToken('long-random-secret', 'long-random-secreT'), false);
  assert.equal(matchesToken('short', 'long-random-secret'), false);
  assert.equal(matchesToken(undefined, 'long-random-secret'), false);
  assert.ok(DEFAULT_SERVICES.some((service) => service.url === '/watch.html'));
  assert.ok(DEFAULT_SERVICES.length >= 5);
  assert.equal(MAX_SERVICES, 200);
});
