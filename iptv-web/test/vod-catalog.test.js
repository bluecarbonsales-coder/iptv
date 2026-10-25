'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../lib/api');
const vod = require('../lib/vod');
const archive = require('../lib/archive-vod');
const commons = require('../lib/commons-vod');

function invoke(handler, query) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 0,
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) {
        try {
          resolve({ statusCode: this.statusCode, body: JSON.parse(Buffer.from(body).toString('utf8')) });
        } catch (error) { reject(error); }
      },
    };
    Promise.resolve(handler({ headers: {} }, response, {}, query)).catch(reject);
  });
}

test('Movies catalogue uses configured providers and excludes short clips and public-catalogue noise', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-vod-catalog-'));
  const registryFile = path.join(dataDir, 'vod-sources.json');
  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1,
    defaultsSeeded: true,
    sources: [{
      id: 'provider-1',
      name: 'Configured film provider',
      api: 'https://provider.example/api.php/provide/vod',
      kind: 'all',
      enabled: true,
    }],
  }));

  const originalSearchSource = vod.searchSource;
  const originalArchiveSearch = archive.search;
  const originalCommonsSearch = commons.search;
  let archiveCalls = 0;
  let commonsCalls = 0;

  vod.searchSource = async () => [
    {
      id: 'feature-1', sourceId: 'provider-1', sourceName: 'Configured film provider',
      name: 'A Feature Film', logo: null, year: '2024', remarks: '',
      overview: 'A full-length feature film.', category: '电影', kind: 'movies',
    },
    {
      id: 'trailer-1', sourceId: 'provider-1', sourceName: 'Configured film provider',
      name: 'A Feature Film Official Trailer', logo: null, year: '2024', remarks: '',
      overview: '', category: '电影', kind: 'movies',
    },
    {
      id: 'clip-1', sourceId: 'provider-1', sourceName: 'Configured film provider',
      name: 'Random upload', logo: null, year: '', remarks: '',
      overview: '', category: '短视频', kind: 'movies',
    },
  ];
  archive.search = async () => { archiveCalls++; return []; };
  commons.search = async () => { commonsCalls++; return []; };

  t.after(() => {
    vod.searchSource = originalSearchSource;
    archive.search = originalArchiveSearch;
    commons.search = originalCommonsSearch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const api = createApi({}, async () => ({}), dataDir);
  const result = await invoke(api.vodSearch, { type: 'all', q: '' });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.items.map((item) => item.name), ['A Feature Film']);
  assert.equal(result.body.filteredShortForm, 2);
  assert.deepEqual(result.body.providers, [{
    name: 'Configured film provider', ok: true, received: 3, count: 1,
  }]);
  assert.equal(archiveCalls, 0);
  assert.equal(commonsCalls, 0);
});
