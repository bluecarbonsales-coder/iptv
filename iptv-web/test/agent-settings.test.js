'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('../lib/agent-settings');
const sources = require('../lib/sources');

test('persists agent-controlled runtime settings and enforces validated types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-agent-settings-'));
  try {
    const saved = settings.updateSettings(dir, {
      autonomy: 'full',
      automationEnabled: true,
      autoSourceSyncHours: 6,
      refreshHours: 8,
      sourceListUrls: [
        'https://trusted.example/list.json',
        'https://trusted.example/list.json',
      ],
    });
    assert.equal(saved.autonomy, 'full');
    assert.equal(saved.automationEnabled, true);
    assert.equal(saved.autoSourceSyncHours, 6);
    assert.equal(saved.refreshHours, 8);
    assert.deepEqual(saved.sourceListUrls, ['https://trusted.example/list.json']);
    assert.deepEqual(settings.getSettings(dir), saved);
    assert.throws(() => settings.updateSettings(dir, { autonomy: 'arbitrary-shell' }), /autonomy must be/);
    assert.throws(() => settings.updateSettings(dir, { sourceListUrls: ['file:///etc/passwd'] }), /HTTP\(S\)/);
    assert.throws(() => settings.updateSettings(dir, { automationEnabled: 'yes' }), /boolean/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parses LibreTV liveSources and rejects non-http or credential-bearing endpoints', () => {
  const parsed = sources.parseRegistrySources({
    liveSources: [
      { name: 'News', url: 'https://lists.example/news.m3u', epg: 'https://lists.example/epg.xml' },
      { name: 'Duplicate', url: 'https://lists.example/news.m3u' },
      { name: 'File scheme', url: 'file:///etc/passwd' },
      { name: 'Credentials', url: 'https://user:pass@lists.example/list.m3u' },
      { name: 'Unsafe EPG', url: 'https://lists.example/sports.m3u', epg: 'http://u:p@epg.example/epg.xml' },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    name: 'News',
    url: 'https://lists.example/news.m3u',
    epg: 'https://lists.example/epg.xml',
  });
  assert.equal(parsed[1].epg, null);
});
