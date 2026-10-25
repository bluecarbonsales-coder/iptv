'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('source manager has three separate source tabs and simple default login', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  assert.match(html, /value="admin"/);
  assert.match(html, /value="0809"/);
  assert.match(html, /data-tab="radio"/);
  assert.match(html, /data-tab="iptv"/);
  assert.match(html, /data-tab="theatre"/);
  assert.match(html, /Enable all radio sources/);
  assert.match(html, /Enable all IPTV playlists/);
  assert.match(html, /Enable all Theatre sources/);
  assert.match(html, /Add radio station/);
  assert.match(html, /Add IPTV source/);
  assert.match(html, /Add Theatre source/);
});

test('existing IPTV player no longer asks users to enter source API tokens', () => {
  const watch = fs.readFileSync(path.join(root, 'public', 'watch.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(watch, /href="\/admin\.html"/);
  assert.doesNotMatch(watch, /Management token|id="sourceToken"|id="vodToken"/i);
  assert.doesNotMatch(app, /sourceHeaders\(|sourceToken|vodToken|X-Source-Token/);
});

test('server exposes basic username/password protected APIs for each source type', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /process\.env\.ADMIN_USERNAME\s*\|\|\s*'admin'/);
  assert.match(server, /process\.env\.ADMIN_PASSWORD\s*\|\|\s*'0809'/);
  assert.match(server, /\/admin\/api\/radio\/sources/);
  assert.match(server, /\/admin\/api\/iptv\/sources/);
  assert.match(server, /\/admin\/api\/theatre\/sources/);
  assert.match(server, /adminAuthenticated\s*=\s*true/);
});
