'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../lib/api');
const { Catalog } = require('../lib/catalog');
const archive = require('../lib/archive-vod');

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body == null ? '' : String(body); },
  };
}

test('Theatre falls back to an explicitly open-license movie source when none is enabled', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-vod-fallback-'));
  const originalSearch = archive.search;
  const film = archive.normalizedDoc({
    identifier: 'sample-public-domain-feature',
    title: 'Sample Public Domain Feature',
    year: 1925,
    licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
  });
  let calledWith = null;
  try {
    archive.search = async (term, kind, limit) => {
      calledWith = { term, kind, limit };
      return [film];
    };
    const api = createApi(new Catalog(dataDir), async () => ({}), dataDir);
    const res = responseRecorder();
    await api.vodSearch(
      { headers: { 'accept-encoding': '' } },
      res,
      {},
      { type: 'movies', q: 'classic' }
    );

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(calledWith, { term: 'classic', kind: 'movies', limit: 30 });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].sourceId, 'archive');
    assert.equal(body.items[0].vodId, 'sample-public-domain-feature');
    assert.equal(body.items[0].pageUrl, 'https://archive.org/details/sample-public-domain-feature');
    assert.equal(body.providers[0].name, 'Internet Archive (open-license fallback)');
    assert.equal(body.providers[0].count, 1);
  } finally {
    archive.search = originalSearch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
