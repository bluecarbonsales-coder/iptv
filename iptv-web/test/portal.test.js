'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPortalApi, isSafeServiceUrl, validateService, matchesToken, DEFAULT_SERVICES, MAX_SERVICES } = require('../lib/portal');

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
  assert.ok(DEFAULT_SERVICES.some((service) => service.id === 'theatre' && service.url === '/movies.html'));
  assert.ok(DEFAULT_SERVICES.some((service) => service.id === 'nodecast-tv' && service.url === 'https://player.nafisainternational.com'));
  assert.ok(DEFAULT_SERVICES.some((service) => service.id === 'public-radio' && service.url === '/radio.html'));
  assert.ok(DEFAULT_SERVICES.some((service) => service.id === 'seedhub' && service.category === 'Media resources'));
  assert.ok(DEFAULT_SERVICES.some((service) => service.id === 'streambert' && service.url === 'https://github.com/truelockmc/streambert'));
  assert.ok(DEFAULT_SERVICES.length >= 5);
  assert.equal(MAX_SERVICES, 200);
});


test('existing portal data is migrated with Nodecast TV while preserving custom links and removals', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-portal-migration-'));
  try {
    fs.writeFileSync(path.join(dataDir, 'portal-services.json'), JSON.stringify({
      version: 1,
      services: [{ id: 'custom-service', name: 'Custom', url: 'https://custom.example/', category: 'Work' }],
    }));
    const portal = createPortalApi({ dataDir });
    const services = portal.getServices();
    const ids = services.map((item) => item.id);
    assert.ok(ids.includes('custom-service'));
    assert.ok(ids.includes('public-radio'));
    assert.ok(ids.includes('theatre'));
    assert.ok(ids.includes('seedhub'));
    assert.ok(ids.includes('streambert'));
    assert.ok(ids.includes('nodecast-tv'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-services.json'), 'utf8')).version, 4);

    // User removals should persist once the one-time migration has completed.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'portal-services.json'), 'utf8'));
    saved.services = saved.services.filter((item) => !['seedhub', 'nodecast-tv'].includes(item.id));
    fs.writeFileSync(path.join(dataDir, 'portal-services.json'), JSON.stringify(saved));
    assert.equal(portal.getServices().some((item) => item.id === 'seedhub'), false);
    assert.equal(portal.getServices().some((item) => item.id === 'nodecast-tv'), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
