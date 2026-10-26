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

test('IPTV defaults to China and requires a selected country instead of listing the global catalogue', () => {
  assert.match(iptvHtml, /id="country"/);
  assert.match(iptvHtml, /id="language"/);
  assert.ok(iptvHtml.indexOf('id="country"') < iptvHtml.indexOf('id="language"'));
  assert.match(iptvJs, /country: 'cn'/);
  assert.match(iptvJs, /language: ''/);
  assert.match(iptvJs, /if \(!state\.country\)/);
  assert.match(iptvJs, /Choose a country…/);
  assert.match(iptvJs, /code === 'cn'.*name === 'china'/s);
  assert.match(iptvJs, /code === 'us'.*name === 'united states'/s);
  assert.match(iptvJs, /code === 'es'.*name === 'spain'/s);
  assert.match(iptvJs, /p\.set\('country', state\.country\)/);
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

test('Radio defaults to China, orders countries consistently, and never requests all stations', () => {
  assert.match(radioHtml, /href="\/watch\.html"/);
  assert.ok(radioHtml.indexOf('id="countryFilter"') < radioHtml.indexOf('id="languageFilter"'));
  assert.match(radioHtml, /Choose a country…/);
  assert.match(radioJs, /countrycode: 'CN'/);
  assert.match(radioJs, /if \(!state\.countrycode\)/);
  assert.match(radioJs, /code === 'CN'/);
  assert.match(radioJs, /code === 'US'/);
  assert.match(radioJs, /code === 'ES'/);
  assert.doesNotMatch(radioJs, /state\.language = preferred\.name/);
  assert.match(radioJs, /stationLanguage \+ ' · ' \+ flagOrCountry\(station\)/);
});
