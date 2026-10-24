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
const { send, sendJson, isPrivateIp } = require('./lib/util');
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
const portal = createPortalApi({ dataDir: DATA_DIR });
const agent = createAgentApi({ dataDir: DATA_DIR, catalog, refresh: refreshNow, api, automation, navigationConfig, visitorContext, portal });
const resourceAvailability = createResourceAvailability({ getServices: portal.getServices });
const radio = createRadioApi();
const mail = createMailApi({ dataDir: DATA_DIR });
const metadata = createMetadataApi();
const staticHandler = serveStatic(PUBLIC_DIR);

// POST /api/refresh drags 18 MB from iptv-org: allow it freely from the host itself,
// require the shared token for anything that arrived through the reverse proxy.
function refreshGuard(req, res, params, query) {
  const viaProxy = !!req.headers['x-forwarded-for'] || !!req.headers['x-real-ip'];
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const local = remote === '127.0.0.1' || remote === '::1' || isPrivateIp(remote);
  const token = process.env.REFRESH_TOKEN || '';
  if (!viaProxy && local) return api.refreshNow(req, res, params, query);
  const given = req.headers['x-refresh-token'];
  const tokenMatches = typeof given === 'string' && token &&
    Buffer.from(given).length === Buffer.from(token).length &&
    require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (tokenMatches) return api.refreshNow(req, res, params, query);
  return sendJson(req, res, 403, { error: 'refresh is restricted', hint: 'send X-Refresh-Token' });
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
app.use(staticHandler);

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
  if (!process.env.AGENT_API_TOKEN) log('agent API disabled: configure AGENT_API_TOKEN to enable Hermes/agent control endpoints');
  const age = catalog.meta.updated ? (Date.now() - Date.parse(catalog.meta.updated)) / 3.6e6 : Infinity;
  if (!catalog.ready || (REFRESH_HOURS > 0 && age > REFRESH_HOURS)) {
    log(`catalogue missing or ${age === Infinity ? 'absent' : `${age.toFixed(1)}h`} old → refreshing in background`);
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
