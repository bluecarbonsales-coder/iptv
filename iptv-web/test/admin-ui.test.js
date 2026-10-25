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
  assert.match(html, /data-tab="api"/);
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
  assert.match(server, /process\.env\.ADMIN_USERNAME\s*\|\|\s*'admin'/);
  assert.match(server, /process\.env\.ADMIN_PASSWORD\s*\|\|\s*'0809'/);
  assert.match(server, /\/admin\/api\/radio\/sources/);
  assert.match(server, /\/admin\/api\/iptv\/sources/);
  assert.match(server, /\/admin\/api\/theatre\/sources/);
  assert.match(server, /adminAuthenticated\s*=\s*true/);
  assert.match(server, /app\.get\('\/api\/v1',/);
  assert.match(server, /app\.get\('\/api\/v1\/openapi\.json',/);
  assert.match(server, /app\.get\('\/api\/v1\/sources',/);
  assert.match(server, /app\.post\('\/api\/v1\/sources\/:type',/);
  assert.match(server, /app\.patch\('\/api\/v1\/sources\/:type\/:id',/);
  assert.match(server, /app\.delete\('\/api\/v1\/sources\/:type\/:id',/);
});

test('Settings compares browser and server source availability without agent-token controls', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'lib', 'api.js'), 'utf8');
  assert.match(html, /id="sourceHealthSummary"/);
  assert.match(html, /id="refreshSourceHealth"/);
  assert.match(js, /\/api\/v1\/sources\/health/);
  assert.match(js, /mode: 'no-cors'/);
  assert.match(js, /Current network:/);
  assert.match(server, /app\.get\('\/api\/v1\/sources\/health'/);
  assert.match(server, /Token-based agent access is disabled/);
  assert.match(api, /Token-based source management has been disabled/);
});

test('IPTV and Theatre playback render inline in the page rather than as fixed overlays', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const theatre = fs.readFileSync(path.join(root, 'public', 'movies.html'), 'utf8');
  assert.match(css, /\.player \{ position: relative; inset: auto;/);
  assert.match(app, /\$\('#player'\)\.scrollIntoView/);
  assert.match(theatre, /\.player-modal\{position:relative;inset:auto;/);
  assert.match(theatre, /Embedded media player/);
  assert.match(theatre, /\$\('#playerModal'\)\.scrollIntoView/);
});
