'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('source manager has separate source tabs and persisted credential settings', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  assert.match(html, /id="username" autocomplete="username" value=""/);
  assert.match(html, /id="password" type="password" autocomplete="current-password" value=""/);
  assert.match(html, /id="adminCredentialsForm"/);
  assert.match(html, /id="newAdminUsername"/);
  assert.match(html, /id="newAdminPassword"/);
  assert.match(html, /id="confirmAdminPassword"/);
  assert.match(html, /data-tab="radio"/);
  assert.match(html, /data-tab="iptv"/);
  assert.match(html, /data-tab="theatre"/);
  assert.match(html, /data-tab="api"/);
  assert.match(html, /id="sourceHealthSummary"/);
  assert.match(html, /id="checkAllSources"/);
  assert.match(html, /id="defaultProxy"/);
  assert.match(html, /id="saveMediaSettings"/);
  assert.match(html, /id="apiTryForm"/);
  assert.match(html, /id="apiEndpointGroups"/);
  assert.doesNotMatch(html, /id="apiAgentToken"|Optional agent token/i);
  assert.match(html, /href="\/api\/v1\/openapi\.json"/);
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
  assert.match(server, /createAdminAuth/);
  assert.match(server, /ownerAuth\.getUsername\(\)/);
  assert.match(server, /app\.post\('\/admin\/api\/credentials'/);
  assert.match(server, /\/admin\/api\/radio\/sources/);
  assert.match(server, /\/admin\/api\/iptv\/sources/);
  assert.match(server, /\/admin\/api\/theatre\/sources/);
  assert.match(server, /adminAuthenticated\s*=\s*true/);
  assert.match(server, /app\.get\('\/api\/v1',/);
  assert.match(server, /app\.get\('\/api\/v1\/openapi\.json',/);
  assert.match(server, /app\.get\('\/api\/v1\/sources',/);
  assert.match(server, /app\.get\('\/api\/v1\/sources\/health',/);
  assert.match(server, /app\.put\('\/api\/v1\/settings\/media',/);
  assert.match(server, /token authentication is disabled/);
  assert.match(server, /app\.post\('\/api\/v1\/sources\/:type',/);
  assert.match(server, /app\.patch\('\/api\/v1\/sources\/:type\/:id',/);
  assert.match(server, /app\.delete\('\/api\/v1\/sources\/:type\/:id',/);
});
