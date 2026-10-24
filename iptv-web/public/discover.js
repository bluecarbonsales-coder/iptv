'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateUrl, readSaved, writeSaved, matchesToken } = require('../lib/media-discovery');

test('media links accept HTTP(S) and valid BitTorrent magnet links', () => {
  assert.equal(validateUrl('https://example.org/watch?id=1'), 'https://example.org/watch?id=1');
  assert.match(validateUrl('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), /^magnet:/);
});
test('media links reject unsafe protocols, credentials and malformed magnets', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.org', 'magnet:?xt=urn:btih:bad', '']) assert.equal(validateUrl(value), null);
});
test('saved links persist atomically and management tokens compare exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-links-'));
  try {
    writeSaved(dir, [{ id:'a', title:'Example', url:'https://example.org' }]);
    assert.equal(readSaved(dir)[0].id, 'a');
    assert.equal(matchesToken('secret', 'secret'), true);
    assert.equal(matchesToken('secret', 'secret2'), false);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});