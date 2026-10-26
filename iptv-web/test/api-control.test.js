'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApiControl } = require('../lib/api-control');

test('API control defaults to enabled and persists administrator changes', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-api-control-'));
  try {
    const control = createApiControl(dataDir);
    assert.deepEqual(control.read(), { enabled: true });
    assert.deepEqual(control.save({ enabled: false }), { enabled: false });
    assert.deepEqual(control.read(), { enabled: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'api-control.json'), 'utf8')), { enabled: false });
    assert.deepEqual(control.save({ enabled: true }), { enabled: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('API control rejects missing or non-boolean enabled values', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-api-control-'));
  try {
    const control = createApiControl(dataDir);
    assert.throws(() => control.save({}), /enabled must be true or false/);
    assert.throws(() => control.save({ enabled: 'false' }), /enabled must be true or false/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
