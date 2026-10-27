'use strict';

// Regression tests for the "browse channels by language" page.
//
// Two defects made the IPTV tab list nothing at all:
//  1. iptv-org moved the channel -> language mapping out of channels.json (each feed in
//     feeds.json carries its languages), so every channel was built with `languages: []`,
//     the language facet came out empty and the page had nothing to browse.
//  2. lib/sources.js#mergeInto rebuilt meta from scratch and dropped `languages` entirely,
//     so even a catalogue that had been indexed lost the facet on the next refresh.
// The checks below pin both: languages come from feeds.json, merging custom M3U sources
// keeps the facet (with refreshed counts) and every channel record carries a language array
// (server.js treats a missing array as "index missing" and re-refreshes on every boot).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../lib/refresh');
const { mergeInto } = require('../lib/sources');

const API = {
  'channels.json': [
    { id: 'english.one', name: 'English News', country: 'US', categories: ['news'] },
    { id: 'spanish.one', name: 'Spanish News', country: 'ES', categories: ['news'] },
    { id: 'mute.one', name: 'No Feed Channel', country: 'IN', categories: ['news'] },
  ],
  'feeds.json': [
    { channel: 'english.one', id: 'english.one.us', languages: ['eng'] },
    { channel: 'english.one', id: 'english.one.uk', languages: ['eng', 'spa'] },
    { channel: 'spanish.one', id: 'spanish.one.es', languages: ['spa'] },
  ],
  'streams.json': [
    { channel: 'english.one', url: 'https://stream.example/english.m3u8', quality: '720p' },
    { channel: 'spanish.one', url: 'https://stream.example/spanish.m3u8', quality: '720p' },
    { channel: 'mute.one', url: 'https://stream.example/mute.m3u8', quality: '720p' },
  ],
  'logos.json': [],
  'categories.json': [{ id: 'news', name: 'News' }],
  'countries.json': [
    { code: 'US', name: 'United States', flag: '🇺🇸', languages: ['eng'] },
    { code: 'ES', name: 'Spain', flag: '🇪🇸', languages: ['spa'] },
    { code: 'IN', name: 'India', flag: '🇮🇳', languages: ['hin', 'eng'] },
  ],
  'languages.json': [
    { code: 'eng', name: 'English' },
    { code: 'spa', name: 'Spanish' },
    { code: 'hin', name: 'Hindi' },
  ],
};

test('channels take their languages from feeds.json and the facet is indexed', () => {
  const { channels, meta } = build(API, {});
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  assert.deepEqual(byId.get('english.one').languages, ['eng', 'spa']);
  assert.deepEqual(byId.get('spanish.one').languages, ['spa']);
  // No feed row and no channel-level languages: the country's languages are the fallback.
  assert.deepEqual(byId.get('mute.one').languages, ['hin', 'eng']);
  // LANGUAGE_PRIORITY in lib/refresh.js orders the common global languages ahead of the rest,
  // so the facet is eng, hin, spa — not alphabetical and not by count.
  assert.deepEqual(meta.languages.map((language) => language.code), ['eng', 'hin', 'spa']);
  assert.equal(meta.languages.find((language) => language.code === 'eng').count, 2);
});

test('merging custom sources keeps the language facet instead of emptying it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-language-facet-'));
  try {
    const built = build(API, {});
    fs.writeFileSync(path.join(dataDir, 'sources.json'), JSON.stringify({ sources: [] }));
    const merged = await mergeInto({ channels: built.channels, meta: built.meta }, dataDir, () => {});
    assert.deepEqual(merged.meta.languages.map((language) => language.code), ['eng', 'hin', 'spa']);
    assert.equal(merged.meta.languages.find((language) => language.code === 'eng').count, 2);
    assert.ok(merged.channels.every((channel) => Array.isArray(channel.languages)));

    // A channel without a language array (a row written by an older build) must not survive
    // the merge: server.js re-refreshes the whole catalogue while one is missing.
    const legacy = { channels: [{ id: 'legacy.one', name: 'Legacy', country: 'US', languages: undefined, streams: [] }] };
    fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify(legacy));
    const again = await mergeInto({ channels: built.channels.concat(legacy.channels), meta: built.meta }, dataDir, () => {});
    assert.ok(again.channels.every((channel) => Array.isArray(channel.languages)));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
