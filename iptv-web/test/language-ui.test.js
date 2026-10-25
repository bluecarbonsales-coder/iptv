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

test('IPTV channels default to a language filter and use language metadata instead of country as the main grouping', () => {
  assert.match(iptvHtml, /id="language"/);
  assert.ok(iptvHtml.indexOf('id="language"') < iptvHtml.indexOf('id="country"'));
  assert.match(iptvJs, /language: 'eng'/);
  assert.match(iptvJs, /p\.set\('language', state\.language\)/);
  assert.match(iptvJs, /it\.languages\.slice\(0, 2\)\.map\(languageLabel\)/);
  assert.match(i18nJs, /tabAll: 'IPTV'/);
  assert.match(i18nJs, /tabAll: 'IPTV频道'/);
});

test('IPTV video stays embedded and does not offer an external raw-stream player link', () => {
  assert.match(iptvHtml, /<video id="video" controls playsinline autoplay><\/video>/);
  assert.doesNotMatch(iptvHtml, /id="pOpen"|Open stream in a new tab/);
  assert.doesNotMatch(iptvJs, /pOpen/);
  assert.doesNotMatch(iptvHtml, /Live TV|Live channels/);
  assert.match(iptvHtml, /IPTV channels/);
});

test('Radio defaults to the highest-priority available language and keeps country secondary', () => {
  assert.match(radioHtml, /<a href="\/watch\.html">IPTV<\/a>/);
  assert.ok(radioHtml.indexOf('id="languageFilter"') < radioHtml.indexOf('id="countryFilter"'));
  assert.match(radioJs, /SPOKEN_LANGUAGE_PRIORITY/);
  assert.match(radioJs, /values\.sort\(\(a, b\) => languageRank/);
  assert.match(radioJs, /values\.find\(\(item\) => \/\^\(english\|eng\)\$\/i/);
  assert.match(radioJs, /stationLanguage \+ ' · ' \+ flagOrCountry\(station\)/);
});
