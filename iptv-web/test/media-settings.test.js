'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaSettings } = require('../lib/media-settings');
test('media settings default to relay and persist the chosen setting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-media-settings-'));
  try {
    const store = createMediaSettings(dir);
    assert.deepEqual(store.read(), { defaultProxy: true });
    assert.deepEqual(store.save({ defaultProxy: false }), { defaultProxy: false });
    assert.deepEqual(createMediaSettings(dir).read(), { defaultProxy: false });
    assert.throws(() => store.save({ defaultProxy: 'false' }), /defaultProxy must be true or false/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
