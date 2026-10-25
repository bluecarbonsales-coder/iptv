'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sources = require('../lib/radio-sources');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-radio-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('radio directory is enabled by default and visible in the source list', (t) => {
  const dir = tempDir(t);
  assert.equal(sources.loadSync(dir).directoryEnabled, true);
  assert.equal(sources.ensureEnabled(dir), false);
  const list = sources.list(dir);
  assert.equal(list[0].id, 'radio-browser');
  assert.equal(list[0].enabled, true);
  assert.equal(sources.loadSync(dir).allSourcesEnabledOnce, true);
});

test('one-time upgrade enables all radio sources but later manual disable is preserved', (t) => {
  const dir = tempDir(t);
  const id = crypto.randomUUID();
  sources.save(dir, {
    directoryEnabled: false,
    allSourcesEnabledOnce: false,
    stations: [{ id, name: 'Test Station', url: 'https://radio.example/live.mp3', enabled: false }],
  });
  assert.equal(sources.ensureEnabled(dir), true);
  let config = sources.loadSync(dir);
  assert.equal(config.directoryEnabled, true);
  assert.equal(config.stations[0].enabled, true);
  config.directoryEnabled = false;
  config.stations[0].enabled = false;
  sources.save(dir, config);
  assert.equal(sources.ensureEnabled(dir), false);
  config = sources.loadSync(dir);
  assert.equal(config.directoryEnabled, false);
  assert.equal(config.stations[0].enabled, false);
});

test('adds, toggles, enables all, and removes custom radio stations', (t) => {
  const dir = tempDir(t);
  const station = sources.add(dir, {
    name: '  Example Radio ',
    url: 'https://radio.example/live.mp3#player',
    language: 'English',
    country: 'Japan',
    countrycode: 'jp',
    genre: 'Jazz',
  });
  assert.equal(station.name, 'Example Radio');
  assert.equal(station.url, 'https://radio.example/live.mp3');
  assert.equal(station.countrycode, 'JP');
  assert.equal(sources.list(dir).length, 2);
  assert.equal(sources.stationById(dir, station.id).url, station.url);

  sources.update(dir, station.id, { enabled: false });
  assert.equal(sources.stationById(dir, station.id), null);
  assert.equal(sources.list(dir).find((entry) => entry.id === station.id).enabled, false);
  sources.enableAll(dir);
  assert.equal(sources.stationById(dir, station.id).enabled, true);
  assert.throws(() => sources.add(dir, { name: 'Duplicate', url: station.url }), /already exists/);
  assert.throws(() => sources.remove(dir, 'radio-browser'), /cannot be deleted/);
  assert.equal(sources.remove(dir, station.id), true);
  assert.equal(sources.list(dir).length, 1);
});

test('rejects unsafe custom radio URLs', (t) => {
  const dir = tempDir(t);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@radio.example/live.mp3']) {
    assert.throws(() => sources.add(dir, { name: 'Bad station', url }), /URL/);
  }
});
