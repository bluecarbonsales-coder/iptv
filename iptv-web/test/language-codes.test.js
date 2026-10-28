'use strict';

// Language codes arriving from third-party playlists and a minority of the iptv-org feeds.
//
// Two user-visible defects are pinned here:
//  1. `tvg-language` was parsed but thrown away by lib/sources.js#buildChannels, so every
//     channel of every custom list was built with `languages: []`. The Spanish/Turkish/English
//     filters therefore showed none of the curated lists (Pluto TV España, Free-TV Türkiye …)
//     even though the lists are language-specific — the browse page looked "not separated".
//  2. Codes were taken verbatim, so the 639-2/B forms ("FRE", "GER", "DUT", "JAP", "CZE",
//     "ARM") became their own facet entries next to "French"/"German"/… and a language filter
//     missed those channels. Only clear aliases are merged: distinct codes iptv-org keeps
//     apart (zho vs cmn vs yue) must survive untouched — test/language-index.test.js pins cmn.

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalLanguage, canonicalLanguages } = require('../lib/languages');
const { buildChannels } = require('../lib/sources');

test('canonicalLanguage maps 639-2/B and 639-1 forms onto the 639-3 codes the catalogue uses', () => {
  assert.equal(canonicalLanguage('FRE'), 'fra');
  assert.equal(canonicalLanguage('ger'), 'deu');
  assert.equal(canonicalLanguage('DUT'), 'nld');
  assert.equal(canonicalLanguage('JAP'), 'jpn');
  assert.equal(canonicalLanguage('CZE'), 'ces');
  assert.equal(canonicalLanguage('ARM'), 'hye');
  assert.equal(canonicalLanguage('es'), 'spa');
  assert.equal(canonicalLanguage('Spanish'), 'spa');
  assert.equal(canonicalLanguage('es-ES'), 'spa');
  assert.equal(canonicalLanguage('spa_Latn'), 'spa');
  // Already canonical, and deliberately distinct variants, pass through unchanged.
  assert.equal(canonicalLanguage('eng'), 'eng');
  assert.equal(canonicalLanguage('cmn'), 'cmn');
  assert.equal(canonicalLanguage('yue'), 'yue');
  // Unknown names are dropped rather than invented into the facet.
  assert.equal(canonicalLanguage('klingon'), null);
  assert.equal(canonicalLanguage(''), null);
  assert.equal(canonicalLanguage(null), null);
});

test('canonicalLanguages splits tag lists and de-duplicates', () => {
  assert.deepEqual(canonicalLanguages('spa,tur'), ['spa', 'tur']);
  assert.deepEqual(canonicalLanguages('Spanish;English'), ['spa', 'eng']);
  assert.deepEqual(canonicalLanguages('FRE,FRA,fra'), ['fra']);
  assert.deepEqual(canonicalLanguages('', null), []);
});

test('buildChannels: item tags win, the source configuration is the fallback', () => {
  const tagged = buildChannels(
    { id: 'list1', name: 'Tagged list', language: 'eng', country: 'GB' },
    [{ name: 'Canal 1', url: 'https://example.test/a.m3u8', language: 'Spanish', country: 'ES' }],
  );
  assert.deepEqual(tagged[0].languages, ['spa']);
  assert.equal(tagged[0].country, 'ES');

  const untagged = buildChannels(
    { id: 'list2', name: 'Pluto TV España (ES)', language: 'ES', country: 'ES' },
    [{ name: 'Canal 2', url: 'https://example.test/b.m3u8' }],
  );
  assert.deepEqual(untagged[0].languages, ['spa']);
  assert.equal(untagged[0].country, 'ES');

  const turkish = buildChannels(
    { id: 'list3', name: 'Free-TV Türkiye (TR)', language: 'tr', country: 'TR' },
    [{ name: 'Kanal D', url: 'https://example.test/c.m3u8' }],
  );
  assert.deepEqual(turkish[0].languages, ['tur']);
  assert.equal(turkish[0].country, 'TR');

  // No configuration and no tags: stays empty (nothing is guessed).
  const bare = buildChannels({ id: 'list4', name: 'Bare list' }, [{ name: 'Canal 3', url: 'https://example.test/d.m3u8' }]);
  assert.deepEqual(bare[0].languages, []);
  assert.equal(bare[0].country, null);

  // A 639-2/B tag is canonicalised instead of leaking into the facet.
  const legacy = buildChannels({ id: 'list5', name: 'Legacy tags' }, [{ name: 'TF1', url: 'https://example.test/e.m3u8', language: 'FRE' }]);
  assert.deepEqual(legacy[0].languages, ['fra']);
});

test('buildChannels: a country-only entry takes that country\'s language, names are refused', () => {
  const list = buildChannels({ id: 'list6', name: 'Free-TV/IPTV global playlist' }, [
    { name: 'RTVE', url: 'https://example.test/es.m3u8', country: 'ES' },
    { name: 'TRT 1', url: 'https://example.test/tr.m3u8', country: 'TR' },
    { name: 'PBS', url: 'https://example.test/us.m3u8', country: 'US' },
    { name: 'Name Country', url: 'https://example.test/x.m3u8', country: 'Spain' },
    { name: 'Atlantic', url: 'https://example.test/be.m3u8', country: 'BE' },
  ]);
  const byName = new Map(list.map((channel) => [channel.name, channel]));
  assert.deepEqual(byName.get('RTVE').languages, ['spa']);
  assert.deepEqual(byName.get('TRT 1').languages, ['tur']);
  assert.deepEqual(byName.get('PBS').languages, ['eng']);
  // A country name is not a country code: the field is left empty rather than made up.
  assert.equal(byName.get('Name Country').country, null);
  assert.deepEqual(byName.get('Name Country').languages, []);
  // Belgium speaks several languages, so no guess is made; the code itself is kept.
  assert.equal(byName.get('Atlantic').country, 'BE');
  assert.deepEqual(byName.get('Atlantic').languages, []);
});
