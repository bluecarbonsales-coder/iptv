'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdminAuth } = require('../lib/admin-credentials');

test('single administrator can change username and password and credentials persist', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-admin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAdminAuth({ dataDir, username: 'admin', password: '0809' });
  assert.equal(auth.matches('admin', '0809'), true);
  const result = auth.update('admin', '0809', 'new-owner', 'a-long-unique-password-2026');
  assert.deepEqual(result, { username: 'new-owner' });
  assert.equal(auth.matches('admin', '0809'), false);
  assert.equal(auth.matches('new-owner', 'a-long-unique-password-2026'), true);
  const restarted = createAdminAuth({ dataDir, username: 'ignored-env', password: 'ignored-password' });
  assert.equal(restarted.matches('new-owner', 'a-long-unique-password-2026'), true);
  assert.equal(restarted.matches('ignored-env', 'ignored-password'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-credentials.json'), 'utf8'));
  assert.equal(saved.password.hash.includes('a-long-unique-password-2026'), false);
  assert.equal(saved.password.hash.length, 128);
  assert.equal((fs.statSync(path.join(dataDir, 'admin-credentials.json')).mode & 0o077), 0);
});

test('credential changes require current credentials and strong replacement password', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-admin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAdminAuth({ dataDir, username: 'admin', password: '0809' });
  assert.throws(() => auth.update('admin', 'wrong', 'new-owner', 'a-long-unique-password-2026'), { statusCode: 401 });
  assert.throws(() => auth.update('admin', '0809', 'new-owner', 'short'), { statusCode: 400 });
  assert.equal(auth.matches('admin', '0809'), true);
});

test('admin Basic authentication uses the stored single account', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-admin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const auth = createAdminAuth({ dataDir, username: 'admin', password: '0809' });
  const req = value => ({ headers: value ? { authorization: value } : {} });
  assert.equal(auth.matchesRequest(req('Basic ' + Buffer.from('admin:0809').toString('base64'))), true);
  assert.equal(auth.matchesRequest(req('Bearer admin:0809')), false);
  assert.equal(auth.matchesRequest(req('Basic ' + Buffer.from('admin:wrong').toString('base64'))), false);
});
