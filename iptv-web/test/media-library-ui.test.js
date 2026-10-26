'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'library.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'lib', 'api.js'), 'utf8');

test('Media Library page exposes search, M3U import, and persistent direct-link save forms', () => {
  assert.match(html, /id="searchForm"/);
  assert.match(html, /id="m3uForm"/);
  assert.match(html, /id="playlistUrl"/);
  assert.match(html, /id="saveForm"/);
  assert.match(html, /id="savedUrl"/);
  assert.match(html, /postJson\('\/api\/sources'/);
  assert.match(html, /postJson\('\/api\/library\/items'/);
});

test('server registers authenticated library endpoints and indexes discovered VOD results', () => {
  assert.match(server, /app\.get\('\/api\/library', api\.librarySearch\)/);
  assert.match(server, /app\.get\('\/api\/library\/stats', api\.libraryStats\)/);
  assert.match(server, /app\.post\('\/api\/library\/items', api\.saveLibraryItem\)/);
  assert.match(server, /app\.delete\('\/api\/library\/items\/:id', api\.deleteLibraryItem\)/);
  assert.match(api, /mediaLibrary\.upsert\(sourceDataDir, unique\.map/);
  assert.match(api, /authorizeSourceWrite\(req, res\)/);
});

test('Theatre navigation links to the persistent Media Library', () => {
  const movies = fs.readFileSync(path.join(root, 'public', 'movies.html'), 'utf8');
  assert.match(movies, /href="\/library\.html"/);
});
