'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../lib/sources');

test('accepts only HTTP and HTTPS source URLs', () => {
  assert.equal(sources.isHttpUrl('https://example.com/list.m3u'), true);
  assert.equal(sources.isHttpUrl('http://example.com/list.m3u'), true);
  assert.equal(sources.isHttpUrl('file:///etc/passwd'), false);
  assert.equal(sources.isHttpUrl('javascript:alert(1)'), false);
  assert.equal(sources.isHttpUrl('not a URL'), false);
});

test('groups duplicate channel names and retains unique stream URLs', () => {
  const result = sources.buildChannels(
    { id: 'stest', name: 'Test source' },
    [
      { name: 'News', group: 'Local', url: 'https://one.example/live.m3u8', logo: 'https://one.example/logo.png' },
      { name: 'News', group: 'Local', url: 'https://one.example/live.m3u8' },
      { name: 'News', group: 'Local', url: 'https://two.example/live.m3u8' },
      { name: 'Sports', group: 'Local', url: 'https://one.example/sports.m3u8' },
    ]
  );
  assert.equal(result.length, 2);
  const news = result.find((channel) => channel.name === 'News');
  assert.ok(news);
  assert.equal(news.streams.length, 2);
  assert.equal(news.ns, 2);
  assert.equal(news.src, 'stest');
  assert.equal(news.logo, 'https://one.example/logo.png');
});

test('parses LibreTV liveSources and TVBox lives entries from one registry', () => {
  const parsed = sources.parseRegistrySources({
    liveSources: [
      { name: 'Libre channels', url: 'https://example.org/live.m3u', epg: 'https://example.org/epg.xml' },
      { name: 'Duplicate endpoint', url: 'https://example.org/live.m3u' },
      { name: 'Bad scheme', url: 'file:///etc/passwd' },
      { name: 'Credentials', url: 'https://user:pass@example.org/private.m3u' },
    ],
    lives: [
      { name: 'TVBox live', url: 'https://example.org/tv.txt', epg: 'https://example.org/epg.xml' },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Libre channels');
  assert.equal(parsed[0].epg, 'https://example.org/epg.xml');
  assert.equal(parsed[1].name, 'TVBox live');
});

test('normalizes plain-text channel,url lines and rejects invalid/duplicate stream URLs', () => {
  const parsed = sources.normalizePlaylistItems([
    { name: 'live.m3u8', url: 'CCTV 1,https://tv.example/live.m3u8' },
    { name: 'direct stream', url: 'https://tv.example/live.m3u8' },
    { name: 'Invalid file', url: 'file:///etc/passwd' },
    { name: 'Malformed', url: 'not a playlist URL' },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'CCTV 1');
  assert.equal(parsed[0].url, 'https://tv.example/live.m3u8');
});
