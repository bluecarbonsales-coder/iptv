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
