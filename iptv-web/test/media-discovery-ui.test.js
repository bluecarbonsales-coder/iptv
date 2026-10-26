'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'discover.html'), 'utf8');
const js = fs.readFileSync(path.join(publicDir, 'discover.js'), 'utf8');

test('Media Discovery page loads a browser client rather than Node test code', () => {
  assert.match(html, /id="searchForm"/);
  assert.match(html, /src="\/discover\.js"/);
  assert.match(js, /addEventListener\('submit', search\)/);
  assert.match(js, /\/api\/media\/search/);
  assert.match(js, /\/api\/media\/links/);
  assert.doesNotMatch(js, /require\(['"]node:test['"]\)/);
});
