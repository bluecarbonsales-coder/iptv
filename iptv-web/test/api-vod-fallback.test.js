'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../lib/api');
const { Catalog } = require('../lib/catalog');
const archive = require('../lib/archive-vod');
const vod = require('../lib/vod');

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


test('Theatre keeps the open-license source enabled when a configured provider is enabled', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-vod-combined-'));
  const originalArchiveSearch = archive.search;
  const originalProviderSearch = vod.searchSource;
  const film = archive.normalizedDoc({
    identifier: 'sample-public-domain-feature-2',
    title: 'Sample Public Domain Feature Two',
    year: 1926,
    licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/',
  });
  try {
    vod.saveSources(dataDir, [{
      id: 'owner-source',
      name: 'Authorized owner source',
      api: 'https://provider.example/api.php/provide/vod',
      kind: 'all',
      enabled: true,
      listAction: 'videolist',
    }]);
    archive.search = async () => [film];
    vod.searchSource = async () => [{
      id: 'provider-film-1',
      sourceId: 'owner-source',
      sourceName: 'Authorized owner source',
      name: 'Licensed Provider Feature',
      logo: null,
      category: 'Movies',
      year: '2020',
      remarks: '',
      overview: 'A film from the operator-configured provider.',
      kind: 'movies',
    }];

    const api = createApi(new Catalog(dataDir), async () => ({}), dataDir);
    const res = responseRecorder();
    await api.vodSearch(
      { headers: { 'accept-encoding': '' } },
      res,
      {},
      { type: 'movies', q: '' }
    );

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.items.map((item) => item.sourceId).sort(), ['archive', 'owner-source']);
    assert.equal(body.providers.length, 2);
    assert.equal(body.providers.find((provider) => provider.name === 'Internet Archive (open-license fallback)').ok, true);
    assert.equal(body.providers.find((provider) => provider.name === 'Authorized owner source').count, 1);
  } finally {
    archive.search = originalArchiveSearch;
    vod.searchSource = originalProviderSearch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
