'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const commons = require('../lib/commons-vod');

function page({ licenseUrl, shortName = 'CC BY-SA 4.0', title = 'File:Open Animation.webm', url = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Open_Animation.webm' } = {}) {
  return {
    pageid: 12345,
    title,
    imageinfo: [{
      url,
      thumburl: 'https://upload.wikimedia.org/thumb.jpg',
      extmetadata: {
        LicenseUrl: { value: licenseUrl || 'https://creativecommons.org/licenses/by-sa/4.0/' },
        LicenseShortName: { value: shortName },
        ImageDescription: { value: '<p>Open animated short</p>' },
        Artist: { value: 'Example Artist' },
      },
    }],
  };
}

test('allows declared open licenses and excludes noncommercial or unknown license metadata', () => {
  assert.ok(commons.licenseInfo({ LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' }, LicenseShortName: { value: 'CC BY 4.0' } }));
  assert.ok(commons.licenseInfo({ LicenseUrl: { value: 'https://creativecommons.org/licenses/publicdomain/zero/1.0/' }, LicenseShortName: { value: 'CC0 1.0' } }));
  assert.equal(commons.licenseInfo({ LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0/' }, LicenseShortName: { value: 'CC BY-NC 4.0' } }), null);
  assert.equal(commons.licenseInfo({ LicenseShortName: { value: 'Unknown' } }), null);
});

test('normalizes Commons video metadata, attribution, license and playback', () => {
  const result = commons.normalizePage(page());
  assert.equal(result.id, '12345');
  assert.equal(result.sourceId, 'commons');
  assert.equal(result.kind, 'anime');
  assert.equal(result.episodes[0].url, 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Open_Animation.webm');
  assert.equal(result.pageUrl, 'https://commons.wikimedia.org/wiki/File%3AOpen_Animation.webm');
  assert.match(result.category, /Example Artist/);
  assert.match(result.overview, /Open animated short/);
});

test('rejects media without an approved direct video extension or supported license', () => {
  assert.equal(commons.normalizePage(page({ url: 'https://upload.wikimedia.org/file.jpg' })), null);
  assert.equal(commons.normalizePage(page({ licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', shortName: 'CC BY-NC-SA 4.0' })), null);
  assert.equal(commons.normalizePage({ pageid: 1, title: 'File:missing.webm', imageinfo: [] }), null);
});

test('strips active HTML and normalizes title text', () => {
  assert.equal(commons.clean('<script>alert(1)</script><b>Title</b>&nbsp; test'), 'Title test');
});
