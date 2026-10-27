'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'library.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'lib', 'api.js'), 'utf8');

test('Media Library exposes search but keeps source import and manual URL saving private', () => {
  assert.match(html, /id="searchForm"/);
  assert.match(html, /PRIVATE SOURCE SETTINGS/);
  assert.doesNotMatch(html, /id="m3uForm"|id="playlistUrl"|id="saveForm"|id="savedUrl"/);
  assert.doesNotMatch(html, /sources\.html/);
});
test('server registers authenticated library endpoints and indexes discovered VOD results', () => {
  assert.match(server, /app\.get\('\/api\/library', api\.librarySearch\)/);
  assert.match(server, /app\.get\('\/api\/library\/stats', api\.libraryStats\)/);
  assert.match(server, /app\.post\('\/api\/library\/items', adminRoute\(api\.saveLibraryItem\)\)/);
  assert.match(server, /app\.delete\('\/api\/library\/items\/:id', adminRoute\(api\.deleteLibraryItem\)\)/);
  assert.match(api, /mediaLibrary\.upsert\(sourceDataDir, unique\.map/);
  assert.match(api, /authorizeSourceWrite\(req, res\)/);
});

test('M3U export routes are disabled and remote playlist parsing is owner-only', () => {
  assert.match(server, /app\.get\('\/api\/playlist\.m3u', mediaExportDisabled\)/);
  assert.match(server, /app\.get\('\/api\/export\.m3u', mediaExportDisabled\)/);
  assert.match(server, /app\.get\('\/api\/playlist', adminRoute\(api\.playlist\)\)/);
  assert.doesNotMatch(api, /const exportM3u|Content-Disposition/);
});
test('Theatre navigation links to the persistent Media Library', () => {
  const movies = fs.readFileSync(path.join(root, 'public', 'movies.html'), 'utf8');
  assert.match(movies, /href="\/library\.html"/);
});
