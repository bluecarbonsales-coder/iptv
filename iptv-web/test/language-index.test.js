'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../lib/refresh');
const { Catalog } = require('../lib/catalog');

test('catalogue indexes languages and orders common global languages ahead of the rest', () => {
  const api = {
    'channels.json': [
      { id: 'english.one', name: 'English News', country: 'US', languages: ['eng'], categories: ['news'] },
      { id: 'spanish.one', name: 'Spanish News', country: 'ES', languages: ['spa'], categories: ['news'] },
      { id: 'mandarin.one', name: 'Mandarin News', country: 'CN', languages: ['cmn'], categories: ['news'] },
      { id: 'hindi.one', name: 'Hindi News', country: 'IN', languages: ['hin'], categories: ['news'] },
      { id: 'english.two', name: 'English Sports', country: 'GB', languages: ['eng', 'spa'], categories: ['sports'] },
    ],
    'streams.json': [
      { channel: 'english.one', url: 'https://stream.example/english1.m3u8', quality: '720p' },
      { channel: 'spanish.one', url: 'https://stream.example/spanish.m3u8', quality: '720p' },
      { channel: 'mandarin.one', url: 'https://stream.example/mandarin.m3u8', quality: '720p' },
      { channel: 'hindi.one', url: 'https://stream.example/hindi.m3u8', quality: '720p' },
      { channel: 'english.two', url: 'https://stream.example/english2.m3u8', quality: '720p' },
    ],
    'logos.json': [],
    'categories.json': [{ id: 'news', name: 'News' }, { id: 'sports', name: 'Sports' }],
    'countries.json': [
      { code: 'US', name: 'United States', flag: '🇺🇸' },
      { code: 'ES', name: 'Spain', flag: '🇪🇸' },
      { code: 'IN', name: 'India', flag: '🇮🇳' },
      { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
    ],
    'languages.json': [
      { code: 'eng', name: 'English' },
      { code: 'spa', name: 'Spanish' },
      { code: 'cmn', name: 'Mandarin Chinese' },
      { code: 'hin', name: 'Hindi' },
    ],
  };
  const built = build(api, {});
  assert.deepEqual(built.meta.languages.map((language) => language.code), ['eng', 'cmn', 'hin', 'spa']);
  assert.equal(built.meta.languages.find((language) => language.code === 'eng').count, 2);
  assert.deepEqual(built.channels.find((channel) => channel.id === 'english.two').languages, ['eng', 'spa']);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-language-index-'));
  try {
    fs.writeFileSync(path.join(dataDir, 'catalog.json'), JSON.stringify({ meta: built.meta, channels: built.channels }));
    const catalog = new Catalog(dataDir);
    assert.equal(catalog.load(), true);
    assert.equal(catalog.query({ language: 'eng' }).total, 2);
    assert.equal(catalog.query({ language: 'hin' }).total, 1);
    assert.equal(catalog.query({ language: 'cmn' }).total, 1);
    assert.equal(catalog.query({ language: 'spa', country: 'ES' }).total, 1);
    assert.deepEqual(catalog.query({ language: 'eng' }).items[0].languages, ['eng']);
    const mandarinCard = catalog.query({ language: 'cmn' }).items[0];
    assert.deepEqual(mandarinCard.languages, ['cmn']);
    assert.equal(built.meta.languages.find((language) => language.code === 'cmn').name, 'Mandarin Chinese');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
