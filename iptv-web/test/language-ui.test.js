'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const iptvHtml = fs.readFileSync(path.join(publicDir, 'watch.html'), 'utf8');
const iptvJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
const radioHtml = fs.readFileSync(path.join(publicDir, 'radio.html'), 'utf8');
const radioJs = fs.readFileSync(path.join(publicDir, 'radio.js'), 'utf8');
const i18nJs = fs.readFileSync(path.join(publicDir, 'js', 'i18n.js'), 'utf8');

test('IPTV starts unfiltered and keeps country filtering optional', () => {
  assert.match(iptvHtml, /id="country"/);
  assert.match(iptvHtml, /id="countrySearch"/);
  assert.match(iptvJs, /country: ''/);
  assert.match(iptvJs, /countrySel\.innerHTML = '<option value="">All countries<\/option>'/);
  assert.match(iptvJs, /if \(state\.country\) p\.set\('country', state\.country\)/);
  assert.match(iptvJs, /state\.country = '';/);
  assert.match(iptvJs, /language: ''/);
  assert.match(iptvJs, /p\.set\('language', state\.language\)/);
  assert.match(iptvJs, /it\.languages\.slice\(0, 2\)\.map\(languageLabel\)/);
  assert.match(i18nJs, /tabAll: 'IPTV'/);
  assert.match(i18nJs, /tabAll: 'IPTV频道'/);
});
test('IPTV video stays embedded and does not offer an external raw-stream player link', () => {
  assert.match(iptvHtml, /<div id="dplayer" aria-label="IPTV video player"><\/div>/);
  assert.match(iptvHtml, /dplayer@1\.27\.1\/dist\/DPlayer\.min\.js/);
  assert.match(iptvJs, /new window\.DPlayer/);
  assert.match(iptvJs, /customType\.hls/);
  assert.doesNotMatch(iptvHtml, /id="pOpen"|Open stream in a new tab/);
  assert.doesNotMatch(iptvJs, /pOpen/);
  assert.doesNotMatch(iptvHtml, /Live TV|Live channels/);
  assert.match(iptvHtml, /IPTV channels/);
});

test('Radio defaults to country-first browsing and never requests the global catalogue', () => {
  assert.ok(radioHtml.includes('<a href="/watch.html">IPTV</a>'));
  assert.ok(radioHtml.indexOf('id="countryFilter"') < radioHtml.indexOf('id="languageFilter"'));
  assert.match(radioJs, /countrycode: 'CN'/);
  assert.match(radioJs, /Searching radio stations in the selected country/);
  assert.match(radioJs, /Choose a country to browse radio stations/);
  assert.ok(radioJs.includes('({ CN: 0, US: 1, ES: 2 }'));
  assert.ok(radioJs.includes("stationLanguage + ' · ' + flagOrCountry(station)"));
});
