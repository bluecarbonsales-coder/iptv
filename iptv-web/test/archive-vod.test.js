'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const archive = require('../lib/archive-vod');

test('only admits public-domain or compatible Creative Commons metadata', () => {
  assert.ok(archive.licenseInfo({ licenseurl: 'https://creativecommons.org/publicdomain/zero/1.0/' }));
  assert.ok(archive.licenseInfo({ licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }));
  assert.ok(archive.licenseInfo({ rights: 'Public Domain' }));
  assert.equal(archive.licenseInfo({ licenseurl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' }), null);
  assert.equal(archive.licenseInfo({ licenseurl: 'https://example.org/license' }), null);
  assert.equal(archive.licenseInfo({}), null);
});

test('normalizes archive movie records and identifies animation', () => {
  const film = archive.normalizedDoc({
    identifier: 'classic-film-1920',
    title: 'Classic Film',
    year: 1920,
    licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
  });
  assert.equal(film.id, 'classic-film-1920');
  assert.equal(film.kind, 'movies');
  assert.equal(film.sourceId, 'archive');
  assert.equal(film.vod, true);
  const animation = archive.normalizedDoc({
    identifier: 'free-animation',
    title: 'Public Domain Animated Cartoon',
    subject: ['animation', 'short film'],
    rights: 'Public Domain',
  });
  assert.equal(animation.kind, 'anime');
});

test('rejects invalid archive identifiers and unsupported licenses', () => {
  assert.equal(archive.normalizedDoc({ identifier: '../etc/passwd', title: 'bad', rights: 'Public Domain' }), null);
  assert.equal(archive.normalizedDoc({ identifier: 'unknown-film', title: 'Unknown Film' }), null);
  assert.equal(archive.identifierOf('movie/id'), null);
});

test('prefers browser-compatible files and excludes thumbnails', () => {
  const files = archive.playableFiles([
    { name: 'film.avi', format: 'AVI' },
    { name: '__ia_thumb.jpg', format: 'JPEG' },
    { name: 'film.webm', format: 'WebM' },
    { name: 'film.mp4', format: 'MPEG4' },
    { name: 'notes.txt', format: 'Text' },
  ]);
  assert.deepEqual(files.map((file) => file.name), ['film.mp4', 'film.webm']);
});

test('escapes archive search input and strips HTML from metadata', () => {
  assert.equal(archive.escapeLucene('film OR *:*'), 'film OR');
  assert.equal(archive.cleanText('<b>Classic</b>&nbsp; Film'), 'Classic Film');
});
