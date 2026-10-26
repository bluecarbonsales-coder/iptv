'use strict';

// Regression tests for the open-license (Internet Archive) catalogue records.
// Builds that prefixed the identifier a second time stored vodId 'archive-<id>', so the
// Theatre asked for /api/vod/archive/archive-<id> and every such title 404'd on playback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../lib/api');
const mediaLibrary = require('../lib/media-library');
const catalog = require('../lib/vod-catalog');
const archive = require('../lib/archive-vod');

function responseRecorder() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(body) { this.body = body == null ? '' : String(body); },
  };
}

test('archive catalogue records keep the bare identifier the player resolves', () => {
  const item = catalog.catalogueItem({ id: 'Sita_Sings_the_Blues', sourceId: 'archive', name: 'Sita Sings the Blues', kind: 'movies' }, 'movies');
  assert.equal(item.id, 'vod-archive-Sita_Sings_the_Blues');
  assert.equal(item.vodId, 'Sita_Sings_the_Blues');
  assert.ok(!String(item.vodId).startsWith('archive-'), 'vodId must not carry an archive- prefix');
});

test('records stored with the doubled archive prefix are pruned', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-archive-ids-'));
  try {
    mediaLibrary.upsert(dataDir, [
      { id: 'vod-archive-archive-Sita_Sings_the_Blues', vodId: 'archive-Sita_Sings_the_Blues', sourceId: 'archive', sourceName: 'Internet Archive (open-license)', name: 'Sita Sings the Blues', vod: true, kind: 'video' },
      { id: 'vod-archive-Night_of_the_Living_Dead', vodId: 'Night_of_the_Living_Dead', sourceId: 'archive', sourceName: 'Internet Archive (open-license)', name: 'Night of the Living Dead', vod: true, kind: 'video' },
      { id: 'vod-v123-9', vodId: '9', sourceId: 'v123', sourceName: 'Provider', name: 'Provider Film', vod: true, kind: 'movies' },
    ]);
    assert.equal(mediaLibrary.allItems(dataDir).length, 3);

    assert.equal(catalog.pruneLegacyArchiveIds(dataDir), 1);
    assert.deepEqual(mediaLibrary.allItems(dataDir).map((item) => item.vodId).sort(), ['9', 'Night_of_the_Living_Dead']);
    // idempotent: nothing left to repair
    assert.equal(catalog.pruneLegacyArchiveIds(dataDir), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a Theatre search returns archive titles the detail endpoint can play', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-archive-play-'));
  const originalSearch = archive.search;
  const originalDetail = archive.getDetail;
  const asked = [];
  try {
    fs.writeFileSync(path.join(dataDir, 'vod-sources.json'), JSON.stringify({
      version: 1, defaultsSeeded: true, sources: [],
    }));
    archive.search = async () => [archive.normalizedDoc({
      identifier: 'Sita_Sings_the_Blues',
      title: 'Sita Sings the Blues',
      year: 2008,
      licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
    })];
    archive.getDetail = async (identifier) => {
      asked.push(identifier);
      return {
        id: identifier,
        sourceId: 'archive',
        sourceName: 'Internet Archive (open-license)',
        name: 'Sita Sings the Blues',
        logo: null,
        overview: '',
        year: 2008,
        category: '',
        remarks: '',
        episodes: [{ title: 'SITA_SINGS_MOVIE_ONLY.mp4', url: 'https://archive.org/download/Sita_Sings_the_Blues/SITA_SINGS_MOVIE_ONLY.mp4' }],
      };
    };

    const api = createApi({}, async () => ({}), dataDir);
    const search = responseRecorder();
    await api.vodSearch({ headers: { 'accept-encoding': '' } }, search, {}, { type: 'movies', q: 'sita' });

    const found = JSON.parse(search.body).items.find((item) => item.sourceId === 'archive');
    assert.ok(found, 'the open-license title must appear in the results');
    assert.equal(found.vodId, 'Sita_Sings_the_Blues');

    const detail = responseRecorder();
    await api.vodDetail({ headers: { 'accept-encoding': '' } }, detail, { sourceId: 'archive', vodId: found.vodId });

    assert.equal(detail.status, 200);
    assert.deepEqual(asked, ['Sita_Sings_the_Blues']);
    assert.equal(JSON.parse(detail.body).episodes.length, 1);
  } finally {
    archive.search = originalSearch;
    archive.getDetail = originalDetail;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the boot repair drops the malformed records and restores the titles immediately', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-archive-repair-'));
  const originalHarvest = archive.harvest;
  try {
    mediaLibrary.upsert(dataDir, [{
      id: 'vod-archive-archive-Sita_Sings_the_Blues',
      vodId: 'archive-Sita_Sings_the_Blues',
      sourceId: 'archive',
      sourceName: 'Internet Archive (open-license)',
      name: 'Sita Sings the Blues',
      vod: true,
      kind: 'video',
    }]);
    archive.harvest = async () => {
      const items = [archive.normalizedDoc({
        identifier: 'Sita_Sings_the_Blues',
        title: 'Sita Sings the Blues',
        year: 2008,
        licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      })];
      items.errors = [];
      return items;
    };

    const repair = await catalog.repairLegacyArchiveIds(dataDir);
    assert.equal(repair.removed, 1);
    assert.equal(repair.restored, 1);

    const records = mediaLibrary.allItems(dataDir).filter((item) => item.sourceId === 'archive');
    assert.deepEqual(records.map((item) => item.vodId), ['Sita_Sings_the_Blues']);

    const listed = catalog.browse(dataDir, { kind: 'movies', limit: 10 }).items.filter((item) => item.sourceId === 'archive');
    assert.equal(listed.length, 1, 'the restored title must be browsable again');
    assert.equal(listed[0].vodId, 'Sita_Sings_the_Blues');
  } finally {
    archive.harvest = originalHarvest;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
