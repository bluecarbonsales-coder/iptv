'use strict';
// IPTV Web — browse and watch the iptv-org catalogue (plus any M3U playlist) in a browser.
//
//   PORT=3920 node server.js
//
// Routes:
//   GET  /                     service portal homepage
//   GET  /watch.html           IPTV player UI
//   GET  /radio.html           public radio directory and player
//   GET  /api/meta             facets: countries, categories, qualities, counts
//   GET  /api/channels         ?q=&country=&category=&minQuality=&nsfw=&page=&limit=&sort=
//   GET  /api/channel/:id      full record incl. every stream URL
//   GET  /api/playlist         ?u=<m3u url>   import an external playlist (server-side fetch)
//   GET  /api/playlist.m3u     ?u=<m3u url>   same playlist, rewritten through /hls
//   GET  /api/export.m3u       same filters as /api/channels, as a downloadable playlist
//   POST /api/refresh          re-download the iptv-org API and rebuild the catalogue
//   GET  /hls?u=&r=&ua=        HLS manifest + segment relay (CORS / mixed content / geo fix)
//   GET  /img?u=               logo relay with disk cache
//   GET  /healthz
const http = require('http');
const path = require('path');
const { Router } = require('./lib/router');
const { Catalog } = require('./lib/catalog');
const { createApi } = require('./lib/api');
const { serveStatic } = require('./lib/static');
const { send, sendJson, readBody, isPrivateIp } = require('./lib/util');
const { matchesAdminCredentials } = require('./lib/admin-auth');
const { createMediaSettings } = require('./lib/media-settings');
const { createSourceHealth } = require('./lib/source-health');
const radioSourceStore = require('./lib/radio-sources');
const sourceLib = require('./lib/sources');
const vodLib = require('./lib/vod');
const platformApiDocs = require('./lib/platform-api-docs');
const hls = require('./lib/hls');
const img = require('./lib/img');
const refreshLib = require('./lib/refresh');
const { createAutomation } = require('./lib/automation');
const { createAgentApi } = require('./lib/agent');
const { createPortalApi } = require('./lib/portal');
const { createResourceAvailability } = require('./lib/resource-availability');
const { createRadioApi } = require('./lib/radio');
const { createMailApi } = require('./lib/mail-workspace');
const { createMetadataApi } = require('./lib/metadata');
const { createNavigationConfig } = require('./lib/navigation-config');
const { createVisitorContext } = require('./lib/visitor-context');
const { createHistoryStore } = require('./lib/watch-history');

const PORT = parseInt(process.env.PORT, 10) || 3920;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFRESH_HOURS = parseFloat(process.env.REFRESH_HOURS || '24');

const catalog = new Catalog(DATA_DIR);
const loaded = catalog.load();
const log = (...a) => console.log(new Date().toISOString(), ...a);
log(`catalog: ${loaded ? `${catalog.meta.total} channels / ${catalog.meta.streams} streams (updated ${catalog.meta.updated})` : 'NOT FOUND'}`);

let refreshing = null;
async function refreshNow() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    log('refreshing catalogue from iptv-org api …');
    // Run lib/refresh.js as a child so a hung download cannot wedge the server.
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, 'lib', 'refresh.js')], { env: process.env }, (err, stdout, stderr) => {
        if (stdout) log(stdout.trim().split('\n').slice(-3).join(' | '));
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      });
    });
    catalog.load();
    log(`catalogue reloaded: ${catalog.meta.total} channels`);
    return { channels: catalog.meta.total, streams: catalog.meta.streams, updated: catalog.meta.updated };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

const app = new Router();
let api;
const automation = createAutomation({
  dataDir: DATA_DIR,
  catalog,
  refresh: refreshNow,
  log,
  onProvidersChanged: () => api && api.clearVodCache(),
});
api = createApi(catalog, refreshNow, DATA_DIR, automation);
const navigationConfig = createNavigationConfig(DATA_DIR);
const visitorContext = createVisitorContext(DATA_DIR);
const watchHistory = createHistoryStore(DATA_DIR);
const portal = createPortalApi({ dataDir: DATA_DIR });
const agent = createAgentApi({ dataDir: DATA_DIR, catalog, refresh: refreshNow, api, automation, navigationConfig, visitorContext, portal });
const resourceAvailability = createResourceAvailability({ getServices: portal.getServices });
const mediaSettings = createMediaSettings(DATA_DIR);
const sourceHealth = createSourceHealth({
  getSources: () => ({
    radio: radioSourceStore.list(DATA_DIR).map(s => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false })),
    iptv: sourceLib.loadSourcesSync(DATA_DIR).sources.map(s => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled !== false })),
    theatre: vodLib.loadSourcesSync(DATA_DIR).sources.map(s => ({ id: s.id, name: s.name, url: s.api, enabled: s.enabled !== false })),
  }),
});
const radio = createRadioApi({ dataDir: DATA_DIR });
const mail = createMailApi({ dataDir: DATA_DIR });
const metadata = createMetadataApi();
const staticHandler = serveStatic(PUBLIC_DIR);

// Catalogue refresh is expensive: allow local scheduled jobs, but require Settings login for remote requests.
function refreshGuard(req, res, params, query) {
  const viaProxy = !!req.headers['x-forwarded-for'] || !!req.headers['x-real-ip'];
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // Docker's local bridge address is private too; the app port is intentionally bound to loopback on the host.
  if (!viaProxy && isPrivateIp(remote)) return api.refreshNow(req, res, params, query);
  if (!adminCredentialsMatch(req)) {
    return sendJson(req, res, 401, { error: 'Please sign in at /admin.html to refresh the catalogue. Token authentication is disabled.' });
  }
  req.adminAuthenticated = true;
  res.setHeader('Cache-Control', 'no-store');
  return api.refreshNow(req, res, params, query);
}

// Agent-native API: header-authenticated, machine-readable, audited, and autonomy-gated.
app.get('/api/agent/v1/openapi.json', agent.openApi);
app.get('/api/agent/v1/project/status', agent.projectStatus);
app.get('/api/agent/v1/project/tree', agent.projectTree);
app.get('/api/agent/v1/project/file', agent.projectFile);
app.post('/api/agent/v1/project/commit', agent.projectCommit);
app.post('/api/agent/v1/project/branch', agent.projectBranch);
app.post('/api/agent/v1/project/pr', agent.projectPullRequest);
app.post('/api/agent/v1/project/pr/:number/merge', agent.projectMerge);
app.post('/api/agent/v1/project/dispatch', agent.projectDispatch);
app.get('/api/agent/v1/project/actions', agent.projectActions);
app.get('/api/agent/v1/project/checks/:sha', agent.projectChecks);
app.get('/api/agent/v1/navigation', agent.navigationGet);
app.get('/api/agent/v1/portal/services', agent.portalList);
app.post('/api/agent/v1/portal/services', agent.portalAdd);
app.patch('/api/agent/v1/portal/services/:id', agent.portalUpdate);
app.delete('/api/agent/v1/portal/services/:id', agent.portalDelete);
app.put('/api/agent/v1/navigation', agent.navigationReplace);
app.get('/api/agent/v1/discovery/visitor-trends', agent.visitorTrends);
app.get('/api/agent/v1/capabilities', agent.capabilities);
app.get('/api/agent/v1/status', agent.status);
app.get('/api/agent/v1/settings', agent.settingsView);
app.patch('/api/agent/v1/settings', agent.settingsUpdate);
app.get('/api/agent/v1/audit', agent.auditLog);
app.post('/api/agent/v1/tasks/run', agent.runTask);
app.get('/api/agent/v1/live/sources', agent.liveList);
app.post('/api/agent/v1/live/sources', agent.liveAdd);
app.patch('/api/agent/v1/live/sources/:id', agent.liveUpdate);
app.delete('/api/agent/v1/live/sources/:id', agent.liveDelete);
app.get('/api/agent/v1/vod/sources', agent.vodList);
app.post('/api/agent/v1/vod/sources', agent.vodAdd);
app.post('/api/agent/v1/vod/import', agent.vodImport);
app.patch('/api/agent/v1/vod/sources/:id', agent.vodUpdate);
app.delete('/api/agent/v1/vod/sources/:id', agent.vodDelete);
app.get('/api/agent/v1/vod/search', agent.vodSearch);
app.get('/api/agent/v1/vod/:sourceId/:vodId', agent.vodDetail);
app.get('/api/agent/v1/archive/search', agent.archiveSearch);
app.get('/api/agent/v1/commons/search', agent.commonsSearch);

// Persistent home-page links; only reads are public, all mutations require an existing management token.
app.get('/api/navigation', (req, res) => {
  try { const config = navigationConfig.read(); sendJson(req, res, 200, { ...config, items: config.items.filter((item) => item.enabled !== false) }); }
  catch (err) { sendJson(req, res, 500, { error: 'navigation config unavailable' }); }
});
let visitorContextWindowStart = Date.now();
let visitorContextRequests = 0;
app.get('/api/history/:visitorId', (req, res, params) => {
  try { sendJson(req, res, 200, { records: watchHistory.get(params.visitorId) }); }
  catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not read history' }); }
});
app.post('/api/history/:visitorId', async (req, res, params) => {
  try {
    const body = JSON.parse(await require('./lib/util').readBody(req, 16384));
    sendJson(req, res, 200, watchHistory.record(params.visitorId, body));
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not save history' }); }
});
app.post('/api/visitor/context', async (req, res) => {
  const now = Date.now();
  if (now - visitorContextWindowStart >= 60000) {
    visitorContextWindowStart = now;
    visitorContextRequests = 0;
  }
  if (visitorContextRequests >= 120) return sendJson(req, res, 429, { error: 'visitor discovery submission limit reached; try again later' });
  visitorContextRequests++;
  try {
    const body = JSON.parse(await require('./lib/util').readBody(req, 4096));
    sendJson(req, res, 200, visitorContext.record(body));
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'visitor context was not recorded' }); }
});
app.get('/api/portal/availability', resourceAvailability.handler);
app.get('/api/portal/services', portal.list);
app.post('/api/portal/services', portal.add);
app.patch('/api/portal/services/:id', portal.update);
app.delete('/api/portal/services/:id', portal.remove);

// Authenticated Mail Workspace API (IMAP/SMTP, contacts, and agent drafting).
app.get('/api/mail/session', mail.session);
app.post('/api/mail/login', mail.login);
app.post('/api/mail/logout', mail.logout);
app.get('/api/mail/accounts', mail.accountsList);
app.post('/api/mail/accounts', mail.accountsAdd);
app.post('/api/mail/accounts/bulk-password', mail.accountsBulkPassword);
app.delete('/api/mail/accounts/:id', mail.accountsDelete);
app.post('/api/mail/accounts/:id/test', mail.accountTest);
app.get('/api/mail/folders', mail.folders);
app.get('/api/mail/messages', mail.messages);
app.get('/api/mail/message', mail.message);
app.post('/api/mail/send', mail.send);
app.get('/api/mail/drafts', mail.draftsList);
app.post('/api/mail/drafts', mail.draftsCreate);
app.delete('/api/mail/drafts/:id', mail.draftsDelete);
app.post('/api/mail/drafts/:id/send', mail.draftsSend);
app.get('/api/mail/contacts', mail.contactsList);
app.post('/api/mail/contacts', mail.contactsAdd);
app.patch('/api/mail/contacts/:id', mail.contactsUpdate);
app.delete('/api/mail/contacts/:id', mail.contactsDelete);
app.get('/api/mail/audit', mail.auditList);
app.get('/api/agent/v1/mail/openapi.json', mail.agentOpenApi);
app.get('/api/agent/v1/mail/accounts', mail.agentAccounts);
app.get('/api/agent/v1/mail/folders', mail.agentFolders);
app.get('/api/agent/v1/mail/messages', mail.agentMessages);
app.get('/api/agent/v1/mail/message', mail.agentMessage);
app.get('/api/agent/v1/mail/contacts', mail.agentContacts);
app.get('/api/agent/v1/mail/drafts', mail.agentDrafts);
app.post('/api/agent/v1/mail/drafts', mail.agentDraftCreate);
app.post('/api/agent/v1/mail/drafts/:id/send', mail.agentDraftSend);

// Movie metadata search and title enrichment (API keys remain server-side).
app.get('/api/metadata/search', metadata.search);
app.get('/api/metadata/tvmaze', metadata.tvmazeSearch);
app.get('/api/metadata/title', metadata.title);

// Simple browser-based source manager. Login is a plain username/password from .env
// (defaults: admin / 0809); no separate API token is required for the admin page.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0809';

function adminCredentialsMatch(req) {
  return matchesAdminCredentials(req, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
}

function adminRoute(handler) {
  return async (req, res, params, query) => {
    if (!adminCredentialsMatch(req)) {
      return sendJson(req, res, 401, { error: 'Please sign in with the admin username and password.' });
    }
    req.adminAuthenticated = true;
    res.setHeader('Cache-Control', 'no-store');
    return handler(req, res, params || {}, query || {});
  };
}

app.get('/admin/api/check', adminRoute((req, res) => sendJson(req, res, 200, { ok: true, username: ADMIN_USERNAME })));

app.get('/admin/api/iptv/sources', adminRoute((req, res, params, query) => api.sourceList(req, res, params, query)));
app.post('/admin/api/iptv/sources', adminRoute((req, res, params, query) => api.addSource(req, res, params, query)));
app.patch('/admin/api/iptv/sources/enable-all', adminRoute((req, res) => api.enableAllSources(req, res)));
app.patch('/admin/api/iptv/sources/:id', adminRoute((req, res, params) => api.updateSource(req, res, params)));
app.delete('/admin/api/iptv/sources/:id', adminRoute((req, res, params) => api.deleteSource(req, res, params)));
app.post('/admin/api/iptv/sources/enable-all', adminRoute((req, res) => api.enableAllSources(req, res)));

app.get('/admin/api/theatre/sources', adminRoute((req, res, params, query) => api.listVodSources(req, res, params, query)));
app.post('/admin/api/theatre/sources', adminRoute((req, res, params, query) => api.addVodSource(req, res, params, query)));
app.post('/admin/api/theatre/sources/import', adminRoute((req, res, params, query) => api.importVodSourceList(req, res, params, query)));
app.post('/admin/api/theatre/sources/enable-all', adminRoute((req, res) => api.enableAllVodSources(req, res)));
app.patch('/admin/api/theatre/sources/:id', adminRoute((req, res, params) => api.updateVodSource(req, res, params)));
app.delete('/admin/api/theatre/sources/:id', adminRoute((req, res, params) => api.deleteVodSource(req, res, params)));

app.get('/admin/api/radio/sources', adminRoute((req, res) => sendJson(req, res, 200, { sources: radioSourceStore.list(DATA_DIR) })));
app.post('/admin/api/radio/sources', adminRoute(async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req, 16384));
    const station = radioSourceStore.add(DATA_DIR, body);
    sendJson(req, res, 201, { source: station, sources: radioSourceStore.list(DATA_DIR) });
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not add radio station' }); }
}));
app.post('/admin/api/radio/sources/enable-all', adminRoute((req, res) => sendJson(req, res, 200, { sources: radioSourceStore.enableAll(DATA_DIR) })));
app.patch('/admin/api/radio/sources/:id', adminRoute(async (req, res, params) => {
  try {
    const body = JSON.parse(await readBody(req, 16384));
    const source = radioSourceStore.update(DATA_DIR, params.id, body);
    sendJson(req, res, 200, { source, sources: radioSourceStore.list(DATA_DIR) });
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not update radio source' }); }
}));
app.delete('/admin/api/radio/sources/:id', adminRoute((req, res, params) => {
  try {
    radioSourceStore.remove(DATA_DIR, params.id);
    sendJson(req, res, 200, { ok: true, sources: radioSourceStore.list(DATA_DIR) });
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not delete radio source' }); }
}));

// Public Radio Browser directory and UUID-based stream relay (no arbitrary URL proxy).
app.get('/api/radio/stations', radio.stations);
app.get('/api/radio/options', radio.listOptions);
app.get('/api/radio/resolve/:uuid', radio.resolveStation);
app.get('/api/radio/stream/:ticket', radio.stream);

app.get('/healthz', api.health);
app.get('/api/meta', api.meta);
app.get('/api/sources', api.sourceList);
app.get('/api/vod/sources', api.listVodSources);
app.post('/api/vod/sources', api.addVodSource);
app.post('/api/vod/import', api.importVodSourceList);
app.patch('/api/vod/sources/:id', api.updateVodSource);
app.delete('/api/vod/sources/:id', api.deleteVodSource);
app.get('/api/vod', api.vodSearch);
app.get('/api/vod/:sourceId/:vodId', api.vodDetail);
app.post('/api/sources', api.addSource);
app.patch('/api/sources/:id', api.updateSource);
app.delete('/api/sources/:id', api.deleteSource);
app.get('/api/channels', api.channels);
app.get('/api/channel/:id', api.channel);
app.get('/api/playlist.m3u', api.playlistProxied);
app.get('/api/playlist', api.playlist);
app.get('/api/export.m3u', api.exportM3u);
app.post('/api/refresh', refreshGuard);
app.get('/hls', hls.handler);
app.head('/hls', hls.handler);
app.get('/img', img.handler);

/*
 * Unified platform API: use /api/v1 for one entry point.
 * Old routes remain available so existing pages and integrations keep working.
 */
app.get('/api/v1', (req, res) => sendJson(req, res, 200, platformApiDocs.describeApi()));
app.get('/api/v1/openapi.json', (req, res) => sendJson(req, res, 200, platformApiDocs.buildOpenApi()));
app.get('/api/v1/health', api.health);

function normalizeUnifiedSourceType(raw) {
  const type = String(raw || '').toLowerCase();
  if (type === 'radio') return 'radio';
  if (type === 'iptv' || type === 'live') return 'iptv';
  if (['theatre', 'theater', 'movie', 'movies', 'vod'].includes(type)) return 'theatre';
  throw Object.assign(new Error('Source type must be radio, iptv, or theatre.'), { statusCode: 400 });
}

function unifiedSourceList(type) {
  if (type === 'radio') return radioSourceStore.list(DATA_DIR);
  if (type === 'iptv') {
    return sourceLib.loadSourcesSync(DATA_DIR).sources.map((source) => ({
      id: source.id,
      type: 'iptv',
      name: source.name,
      url: vodLib.redactUrl(source.url),
      enabled: source.enabled !== false,
      count: source.lastCount || 0,
      streams: source.lastStreamCount || 0,
      updated: source.lastUpdated || null,
      error: source.lastError || null,
    }));
  }
  return vodLib.loadSourcesSync(DATA_DIR).sources.map((source) => ({
    ...vodLib.publicSource(source),
    type: 'theatre',
  }));
}

app.get('/api/v1/sources', adminRoute((req, res) => {
  sendJson(req, res, 200, {
    sources: {
      radio: unifiedSourceList('radio'),
      iptv: unifiedSourceList('iptv'),
      theatre: unifiedSourceList('theatre'),
    },
  });
}));

app.get('/api/v1/sources/health', adminRoute((req, res) => {
  const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
  sourceHealth.startScan(force).catch(error => log('source health scan failed:', error && error.message || error));
  return sendJson(req, res, 200, sourceHealth.getSnapshot(), { 'Cache-Control': 'no-store' });
}));

app.get('/api/v1/sources/:type', adminRoute((req, res, params, query) => {
  try {
    const type = normalizeUnifiedSourceType(params.type);
    if (type === 'radio') return sendJson(req, res, 200, { sources: unifiedSourceList(type) });
    if (type === 'iptv') return api.sourceList(req, res, params, query);
    return api.listVodSources(req, res, params, query);
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message }); }
}));

app.post('/api/v1/sources/:type/enable-all', adminRoute(async (req, res, params) => {
  try {
    const type = normalizeUnifiedSourceType(params.type);
    if (type === 'radio') return sendJson(req, res, 200, { sources: radioSourceStore.enableAll(DATA_DIR) });
    if (type === 'iptv') return api.enableAllSources(req, res);
    return api.enableAllVodSources(req, res);
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message }); }
}));

app.post('/api/v1/sources/theatre/import', adminRoute((req, res, params, query) => api.importVodSourceList(req, res, params, query)));
app.post('/api/v1/sources/movies/import', adminRoute((req, res, params, query) => api.importVodSourceList(req, res, params, query)));

app.post('/api/v1/sources/:type', adminRoute(async (req, res, params, query) => {
  try {
    const type = normalizeUnifiedSourceType(params.type);
    if (type === 'radio') {
      const body = JSON.parse(await readBody(req, 16384));
      const source = radioSourceStore.add(DATA_DIR, body);
      return sendJson(req, res, 201, { source, sources: unifiedSourceList(type) });
    }
    if (type === 'iptv') return api.addSource(req, res, params, query);
    return api.addVodSource(req, res, params, query);
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not add source.' }); }
}));

app.patch('/api/v1/sources/:type/:id', adminRoute(async (req, res, params, query) => {
  try {
    const type = normalizeUnifiedSourceType(params.type);
    if (type === 'radio') {
      const body = JSON.parse(await readBody(req, 16384));
      const source = radioSourceStore.update(DATA_DIR, params.id, body);
      return sendJson(req, res, 200, { source, sources: unifiedSourceList(type) });
    }
    if (type === 'iptv') return api.updateSource(req, res, params, query);
    return api.updateVodSource(req, res, params, query);
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not update source.' }); }
}));

app.delete('/api/v1/sources/:type/:id', adminRoute((req, res, params, query) => {
  try {
    const type = normalizeUnifiedSourceType(params.type);
    if (type === 'radio') {
      radioSourceStore.remove(DATA_DIR, params.id);
      return sendJson(req, res, 200, { ok: true, sources: unifiedSourceList(type) });
    }
    if (type === 'iptv') return api.deleteSource(req, res, params);
    return api.deleteVodSource(req, res, params);
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not delete source.' }); }
}));

// Playback defaults are shared across all embedded player pages.
app.get('/api/v1/settings/media', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(req, res, 200, mediaSettings.read());
});
app.put('/api/v1/settings/media', adminRoute(async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req, 8192));
    sendJson(req, res, 200, mediaSettings.save(body), { 'Cache-Control': 'no-store' });
  } catch (error) { sendJson(req, res, error.statusCode || 400, { error: error.message || 'Could not save playback settings.' }); }
}));

// Media APIs use one naming scheme below /api/v1.
app.get('/api/v1/iptv/meta', api.meta);
app.get('/api/v1/iptv/channels', api.channels);
app.get('/api/v1/iptv/channels/:id', api.channel);
app.get('/api/v1/iptv/playlist', api.playlist);
app.get('/api/v1/iptv/playlist.m3u', api.playlistProxied);
app.get('/api/v1/iptv/export.m3u', api.exportM3u);
app.get('/api/v1/iptv/hls', hls.handler);
app.head('/api/v1/iptv/hls', hls.handler);
app.get('/api/v1/iptv/image', img.handler);
app.post('/api/v1/iptv/refresh', adminRoute((req, res) => api.refreshNow(req, res)));

app.get('/api/v1/radio/stations', radio.stations);
app.get('/api/v1/radio/options', radio.listOptions);
app.get('/api/v1/radio/resolve/:uuid', radio.resolveStation);
app.get('/api/v1/radio/stream/:ticket', radio.stream);

app.get('/api/v1/theatre/titles', api.vodSearch);
app.get('/api/v1/theatre/titles/:sourceId/:vodId', api.vodDetail);

// Homepage shortcuts and settings share the same admin login under this API.
app.get('/api/v1/portal/services', (req, res, params, query) => {
  if (query.manage === '1') return adminRoute((innerReq, innerRes, innerParams, innerQuery) => portal.list(innerReq, innerRes, innerParams, innerQuery))(req, res, params, query);
  return portal.list(req, res, params, query);
});
app.get('/api/v1/portal/availability', resourceAvailability.handler);
app.post('/api/v1/portal/services', adminRoute((req, res, params, query) => portal.add(req, res, params, query)));
app.patch('/api/v1/portal/services/:id', adminRoute((req, res, params, query) => portal.update(req, res, params, query)));
app.delete('/api/v1/portal/services/:id', adminRoute((req, res, params, query) => portal.remove(req, res, params, query)));
app.get('/api/v1/navigation', adminRoute((req, res) => {
  try { sendJson(req, res, 200, navigationConfig.read()); }
  catch (err) { sendJson(req, res, err.statusCode || 500, { error: err.message || 'Could not read navigation settings.' }); }
}));
app.put('/api/v1/navigation', adminRoute(async (req, res) => {
  try {
    const body = JSON.parse(await readBody(req, 32768));
    sendJson(req, res, 200, navigationConfig.replace(body));
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not save navigation settings.' }); }
}));

app.get('/api/v1/metadata/search', metadata.search);
app.get('/api/v1/metadata/tvmaze', metadata.tvmazeSearch);
app.get('/api/v1/metadata/title', metadata.title);

app.get('/api/v1/history/:visitorId', (req, res, params) => {
  try { sendJson(req, res, 200, { records: watchHistory.get(params.visitorId) }); }
  catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not read history.' }); }
});
app.post('/api/v1/history/:visitorId', async (req, res, params) => {
  try {
    const body = JSON.parse(await readBody(req, 16384));
    sendJson(req, res, 200, watchHistory.record(params.visitorId, body));
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Could not save history.' }); }
});
app.post('/api/v1/visitor/context', async (req, res) => {
  const now = Date.now();
  if (now - visitorContextWindowStart >= 60000) {
    visitorContextWindowStart = now;
    visitorContextRequests = 0;
  }
  if (visitorContextRequests >= 120) return sendJson(req, res, 429, { error: 'Visitor discovery submission limit reached; try again later.' });
  visitorContextRequests++;
  try {
    const body = JSON.parse(await readBody(req, 4096));
    sendJson(req, res, 200, visitorContext.record(body));
  } catch (err) { sendJson(req, res, err.statusCode || 400, { error: err.message || 'Visitor context was not recorded.' }); }
});

// Mail API aliases retain Mail Workspace's own login/session and mailbox rules.
// The normal legacy cookie path is /api/mail; rewrite it so login works with /api/v1/mail too.
function unifiedMailSessionCookie(handler) {
  return (req, res, params, query) => {
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (String(name).toLowerCase() === 'set-cookie') {
        const rewrite = (item) => String(item).replace(/;\s*Path=\/api\/mail(?=;|$)/i, '; Path=/api/v1/mail');
        value = Array.isArray(value) ? value.map(rewrite) : rewrite(value);
      }
      return originalSetHeader(name, value);
    };
    return handler(req, res, params || {}, query || {});
  };
}
app.get('/api/v1/mail/session', mail.session);
app.post('/api/v1/mail/login', unifiedMailSessionCookie(mail.login));
app.post('/api/v1/mail/logout', unifiedMailSessionCookie(mail.logout));
app.get('/api/v1/mail/accounts', mail.accountsList);
app.post('/api/v1/mail/accounts', mail.accountsAdd);
app.post('/api/v1/mail/accounts/bulk-password', mail.accountsBulkPassword);
app.delete('/api/v1/mail/accounts/:id', mail.accountsDelete);
app.post('/api/v1/mail/accounts/:id/test', mail.accountTest);
app.get('/api/v1/mail/folders', mail.folders);
app.get('/api/v1/mail/messages', mail.messages);
app.get('/api/v1/mail/message', mail.message);
app.post('/api/v1/mail/send', mail.send);
app.get('/api/v1/mail/drafts', mail.draftsList);
app.post('/api/v1/mail/drafts', mail.draftsCreate);
app.delete('/api/v1/mail/drafts/:id', mail.draftsDelete);
app.post('/api/v1/mail/drafts/:id/send', mail.draftsSend);
app.get('/api/v1/mail/contacts', mail.contactsList);
app.post('/api/v1/mail/contacts', mail.contactsAdd);
app.patch('/api/v1/mail/contacts/:id', mail.contactsUpdate);
app.delete('/api/v1/mail/contacts/:id', mail.contactsDelete);
app.get('/api/v1/mail/audit', mail.auditList);

// Advanced agent operations use the same admin login under the /api/v1 prefix.
const unifiedAgent = (handler) => adminRoute((req, res, params, query) => handler(req, res, params, query));
app.get('/api/v1/agent/capabilities', unifiedAgent(agent.capabilities));
app.get('/api/v1/agent/status', unifiedAgent(agent.status));
app.get('/api/v1/agent/settings', unifiedAgent(agent.settingsView));
app.patch('/api/v1/agent/settings', unifiedAgent(agent.settingsUpdate));
app.get('/api/v1/agent/audit', unifiedAgent(agent.auditLog));
app.post('/api/v1/agent/tasks/run', unifiedAgent(agent.runTask));
app.get('/api/v1/agent/sources/iptv', unifiedAgent(agent.liveList));
app.post('/api/v1/agent/sources/iptv', unifiedAgent(agent.liveAdd));
app.patch('/api/v1/agent/sources/iptv/:id', unifiedAgent(agent.liveUpdate));
app.delete('/api/v1/agent/sources/iptv/:id', unifiedAgent(agent.liveDelete));
app.get('/api/v1/agent/sources/theatre', unifiedAgent(agent.vodList));
app.post('/api/v1/agent/sources/theatre', unifiedAgent(agent.vodAdd));
app.post('/api/v1/agent/sources/theatre/import', unifiedAgent(agent.vodImport));
app.patch('/api/v1/agent/sources/theatre/:id', unifiedAgent(agent.vodUpdate));
app.delete('/api/v1/agent/sources/theatre/:id', unifiedAgent(agent.vodDelete));
app.get('/api/v1/agent/theatre/search', unifiedAgent(agent.vodSearch));
app.get('/api/v1/agent/theatre/titles/:sourceId/:vodId', unifiedAgent(agent.vodDetail));
app.get('/api/v1/agent/theatre/archive/search', unifiedAgent(agent.archiveSearch));
app.get('/api/v1/agent/theatre/commons/search', unifiedAgent(agent.commonsSearch));
app.get('/api/v1/agent/navigation', unifiedAgent(agent.navigationGet));
app.put('/api/v1/agent/navigation', unifiedAgent(agent.navigationReplace));
app.get('/api/v1/agent/portal/services', unifiedAgent(agent.portalList));
app.post('/api/v1/agent/portal/services', unifiedAgent(agent.portalAdd));
app.patch('/api/v1/agent/portal/services/:id', unifiedAgent(agent.portalUpdate));
app.delete('/api/v1/agent/portal/services/:id', unifiedAgent(agent.portalDelete));
app.get('/api/v1/agent/discovery/visitor-trends', unifiedAgent(agent.visitorTrends));
app.get('/api/v1/agent/project/status', unifiedAgent(agent.projectStatus));
app.get('/api/v1/agent/project/tree', unifiedAgent(agent.projectTree));
app.get('/api/v1/agent/project/file', unifiedAgent(agent.projectFile));
app.post('/api/v1/agent/project/commit', unifiedAgent(agent.projectCommit));
app.post('/api/v1/agent/project/branch', unifiedAgent(agent.projectBranch));
app.post('/api/v1/agent/project/pr', unifiedAgent(agent.projectPullRequest));
app.post('/api/v1/agent/project/pr/:number/merge', unifiedAgent(agent.projectMerge));
app.post('/api/v1/agent/project/dispatch', unifiedAgent(agent.projectDispatch));
app.get('/api/v1/agent/project/actions', unifiedAgent(agent.projectActions));
app.get('/api/v1/agent/project/checks/:sha', unifiedAgent(agent.projectChecks));
app.get('/api/v1/agent/mail/accounts', unifiedAgent(mail.agentAccounts));
app.get('/api/v1/agent/mail/folders', unifiedAgent(mail.agentFolders));
app.get('/api/v1/agent/mail/messages', unifiedAgent(mail.agentMessages));
app.get('/api/v1/agent/mail/message', unifiedAgent(mail.agentMessage));
app.get('/api/v1/agent/mail/contacts', unifiedAgent(mail.agentContacts));
app.get('/api/v1/agent/mail/drafts', unifiedAgent(mail.agentDrafts));
app.post('/api/v1/agent/mail/drafts', unifiedAgent(mail.agentDraftCreate));
app.post('/api/v1/agent/mail/drafts/:id/send', unifiedAgent(mail.agentDraftSend));

app.use(async (req, res) => {
  const pathname = (() => {
    try { return new URL(req.url, 'http://localhost').pathname; }
    catch { return req.url.split('?')[0]; }
  })();
  if (req.method === 'OPTIONS' && (pathname === '/api/v1' || pathname.startsWith('/api/v1/'))) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  return staticHandler(req, res);
});

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.QUIET_LOGS === '1') return;
    const u = req.url.length > 120 ? req.url.slice(0, 120) + '…' : req.url;
    // silence segment chatter: only log non-2xx for /hls and /img
    const noisy = /^\/(hls|img)\?/.test(req.url);
    if (noisy && res.statusCode < 400) return;
    log(`${res.statusCode} ${req.method} ${u} ${Date.now() - started}ms`);
  });
  app
    .handle(req, res, () => {
      sendJson(req, res, 404, { error: 'not found', path: req.url });
    })
    .catch((err) => {
      log('ERROR', err && err.stack ? err.stack : err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error', detail: String(err && err.message) });
      else try {
        res.end();
      } catch {}
    });
});

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {}
});

server.listen(PORT, HOST, () => {
  log(`IPTV Web listening on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  automation.start();
  log('Agent, source and portal management APIs use the shared HTTP Basic admin login; token authentication is disabled.');
  const age = catalog.meta.updated ? (Date.now() - Date.parse(catalog.meta.updated)) / 3.6e6 : Infinity;
  const missingLanguageIndex = !Array.isArray(catalog.meta.languages) || catalog.channels.some((channel) => !Array.isArray(channel.languages));
  if (!catalog.ready || missingLanguageIndex || (REFRESH_HOURS > 0 && age > REFRESH_HOURS)) {
    log(`catalogue ${!catalog.ready ? 'missing' : missingLanguageIndex ? 'missing language index' : `${age.toFixed(1)}h old`} → refreshing in background`);
    refreshNow().catch((e) => log('background refresh failed:', e.message));
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    automation.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}

module.exports = { server, catalog };
