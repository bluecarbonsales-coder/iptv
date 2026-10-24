'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNavigationConfig, validateNavigation, safeHref } = require('../lib/navigation-config');
const { createVisitorContext, normalizeContext } = require('../lib/visitor-context');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-hermes-')); }

test('navigation validation accepts safe internal and HTTPS links and rejects unsafe links', () => {
  assert.equal(safeHref('/watch.html'), true);
  assert.equal(safeHref('#movies'), true);
  assert.equal(safeHref('https://example.org/catalog'), true);
  assert.equal(safeHref('//evil.example/path'), false);
  assert.equal(safeHref('javascript:alert(1)'), false);
  assert.throws(() => validateNavigation({ items: [{ id: 'bad', label: 'Bad', href: 'javascript:alert(1)' }] }));
});

test('Hermes navigation store preserves disabled entries for future editing', () => {
  const dir = tempDir();
  try {
    const store = createNavigationConfig(dir);
    const initial = store.read();
    assert.ok(initial.items.some((item) => item.id === 'movies'));
    const saved = store.replace({ items: [
      { id: 'movies', label: 'Films', href: '#movies', section: 'movies', group: 'Discover', order: 1, enabled: true },
      { id: 'radio', label: 'Radio', href: '/radio.html', group: 'Media', order: 2, enabled: false },
    ] });
    assert.equal(saved.items.length, 2);
    assert.equal(store.read().items.find((item) => item.id === 'radio').enabled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('visitor resource context requires consent and valid coarse fields', () => {
  assert.throws(() => normalizeContext({ country: 'JP', language: 'en', category: 'movies' }), /consent/);
  assert.deepEqual(normalizeContext({ consent: true, country: 'JP', region: 'Tokyo', language: 'en', category: 'movies' }), {
    country: 'jp', region: 'tokyo', language: 'en', category: 'movies',
  });
  assert.throws(() => normalizeContext({ consent: true, country: 'JPN', language: 'en', category: 'movies' }), /country/);
});

test('visitor trends are aggregate-only and suppress groups below three requests', () => {
  const dir = tempDir();
  try {
    const collector = createVisitorContext(dir);
    const input = { consent: true, country: 'JP', region: 'Tokyo', language: 'en', category: 'radio' };
    collector.record(input);
    collector.record(input);
    assert.equal(collector.trends().length, 0);
    collector.record(input);
    const trends = collector.trends();
    assert.equal(trends.length, 1);
    assert.equal(trends[0].requests, 3);
    assert.equal(trends[0].country, 'jp');
    assert.equal(fs.existsSync(collector.file), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
