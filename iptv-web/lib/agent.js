'use strict';
const crypto = require('crypto');
const { sendJson, readBody } = require('./util');
const vodLib = require('./vod');
const archiveLib = require('./archive-vod');
const sourceLib = require('./sources');

function matchesToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeUrlSummary(raw) {
  try {
    const u = new URL(raw);
    return u.origin + u.pathname + (u.search ? '?[query-redacted]' : '');
  } catch { return '[invalid URL]'; }
}
function createAgentApi({ dataDir, catalog, refresh, api, automation }) {
  function authenticate(req, res) {
    const expected = process.env.AGENT_API_TOKEN;
    if (!expected) {
      sendJson(req, res, 503, {
        error: 'agent API is disabled',
        hint: 'Set a long random AGENT_API_TOKEN and rebuild/restart the application.',
      });
      return false;
    }
    const authHeader = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
    const given = req.headers['x-agent-token'] || (bearer && bearer[1]);
    if (!matchesToken(given, expected)) {
      sendJson(req, res, 401, { error: 'invalid agent token', hint: 'Send X-Agent-Token or Authorization: Bearer <token>.' });
      return false;
    }
    return true;
  }

  function gate(action, write, handler) {
    return async (req, res, params, query) => {
      if (!authenticate(req, res)) return;
      // Normalize bearer auth for existing source-management handlers which also support X-Agent-Token.
      if (!req.headers['x-agent-token'] && /^Bearer\\s+/i.test(String(req.headers.authorization || ''))) {
        req.headers['x-agent-token'] = String(process.env.AGENT_API_TOKEN || '');
      }
      if (write && String(process.env.AGENT_AUTONOMY || 'review').toLowerCase() !== 'full') {
        automation.audit({ actor: 'agent', action, status: 'blocked', summary: 'Write blocked because AGENT_AUTONOMY is not full' });
        return sendJson(req, res, 423, {
          error: 'agent write access is disabled by policy',
          autonomy: process.env.AGENT_AUTONOMY || 'review',
          hint: 'Set AGENT_AUTONOMY=full only if this trusted agent is allowed to add, change, and remove providers autonomously.',
        });
      }
      const started = Date.now();
      res.once('finish', () => {
        automation.audit({
          actor: 'agent',
          action,
          status: res.statusCode < 400 ? 'ok' : 'error',
          summary: 'HTTP ' + res.statusCode + ' (' + (Date.now() - started) + ' ms)',
        });
      });
      return handler(req, res, params || {}, query || {});
    };
  }

  const capabilities = (req, res) => {
    sendJson(req, res, 200, {
      name: 'IPTV Web Agent Control API',
      apiVersion: 'v1',
      capabilities: [
        'inspect health and provider status',
        'search live IPTV catalogue',
        'search Apple CMS / MacCMS VOD providers',
        'discover openly licensed films through Internet Archive metadata',
        'import configured LibreTV/MoonTV/TVBox-compatible provider registries',
        'add, update, enable, disable, and delete providers',
        'run source checks and scheduled maintenance',
        'refresh the live IPTV catalogue',
        'read an audit history of agent/automation actions',
      ],
      autonomy: {
        mode: process.env.AGENT_AUTONOMY || 'review',
        writeEnabled: String(process.env.AGENT_AUTONOMY || 'review').toLowerCase() === 'full',
        allowedRegistryUrls: automation.status().configuredRegistryCount,
        warning: 'Provider directories are untrusted input. Only configure registries you trust. Imported API endpoints are probed before automatic activation in full mode; copyright ownership cannot be inferred from feed availability.',
      },
      sources: {
        live: 'iptv-org catalogue plus explicitly configured M3U/M3U8 resources',
        vod: 'Configured Apple CMS/MacCMS API endpoints',
        publicDomain: 'Internet Archive metadata with public-domain or compatible CC license declarations',
        importFormats: ['LibreTV SourceList JSON: sources[]', 'MoonTV config.json: api_site{}', 'TVBox-style JSON: sites[]'],
      },
      automation: automation.status(),
      limits: {
        sourceRegistryUrls: 32,
        vodProviders: vodLib.MAX_VOD_SOURCES,
        importedRegistryBytes: 1048576,
        archiveResultsPerSearch: 30,
      },
    });
  };

  const status = (req, res) => {
    const m3u = sourceLib.loadSourcesSync(dataDir).sources;
    const vod = vodLib.loadSourcesSync(dataDir).sources;
    sendJson(req, res, 200, {
      ok: true,
      service: 'iptv-web',
      apiVersion: 'v1',
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      liveCatalog: {
        ready: catalog.ready,
        channels: catalog.meta.total || 0,
        streams: catalog.meta.streams || 0,
        updatedAt: catalog.meta.updated || null,
      },
      liveResources: {
        total: m3u.length,
        enabled: m3u.filter((source) => source.enabled !== false).length,
        resources: m3u.map((source) => ({
          id: source.id,
          name: source.name,
          url: safeUrlSummary(source.url),
          enabled: source.enabled !== false,
          lastUpdated: source.lastUpdated || null,
          lastError: source.lastError || null,
        })),
      },
      vod: {
        total: vod.length,
        enabled: vod.filter((source) => source.enabled !== false).length,
        providers: vod.map((source) => ({
          id: source.id,
          name: source.name,
          endpoint: safeUrlSummary(source.api),
          kind: source.kind,
          enabled: source.enabled !== false,
          lastChecked: source.lastChecked || null,
          lastError: source.lastError || null,
          lastItemCount: source.lastItemCount ?? null,
        })),
        publicArchive: 'Internet Archive adapter is built in; search only returns items with declared public-domain or compatible CC licensing.',
      },
      automation: automation.status(),
    });
  };

  const auditLog = (req, res, params, query) => {
    const limit = Math.max(1, Math.min(200, parseInt(query.limit, 10) || 50));
    sendJson(req, res, 200, { entries: automation.readAudit(limit) });
  };

  const runTask = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 8192));
      const task = String(body.task || '').trim();
      const result = await automation.task(task, 'agent');
      sendJson(req, res, 200, { ok: true, task, completedAt: new Date().toISOString(), result });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { ok: false, error: err.message || 'task failed' });
    }
  };

  const openApi = (req, res) => sendJson(req, res, 200, {
    openapi: '3.1.0',
    info: {
      title: 'IPTV Web Agent Control API',
      version: '1.0.0',
      description: 'Machine-oriented control surface for trusted agents such as Hermes. API tokens must be sent in headers, never in query strings.',
    },
    servers: [{ url: '/' }],
    security: [{ AgentToken: [] }],
    components: {
      securitySchemes: {
        AgentToken: { type: 'apiKey', in: 'header', name: 'X-Agent-Token' },
        BearerToken: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/api/agent/v1/capabilities': { get: { summary: 'Describe capabilities, limits and autonomy policy', responses: { '200': { description: 'Capabilities' } } } },
      '/api/agent/v1/status': { get: { summary: 'Get health, catalog and source status', responses: { '200': { description: 'Current service state' } } } },
      '/api/agent/v1/audit': { get: { summary: 'Read recent agent and automation actions', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { '200': { description: 'Audit entries' } } } },
      '/api/agent/v1/tasks/run': { post: { summary: 'Run a maintenance task', description: 'Requires AGENT_AUTONOMY=full. Allowed tasks: maintain_sources, sync_source_lists, check_vod_providers, refresh_live_catalog.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['task'], properties: { task: { type: 'string', enum: ['maintain_sources', 'sync_source_lists', 'check_vod_providers', 'refresh_live_catalog'] } } } } } }, responses: { '200': { description: 'Task result' }, '423': { description: 'Writes blocked by autonomy policy' } } } },
      '/api/agent/v1/live/sources': { get: { summary: 'List configured M3U resources', responses: { '200': { description: 'Resource list' } } }, post: { summary: 'Add and validate a live M3U/M3U8 resource', description: 'Requires AGENT_AUTONOMY=full. Accepts {name,url,enabled?}.', responses: { '201': { description: 'Resource added' } } } },
      '/api/agent/v1/live/sources/{id}': { patch: { summary: 'Rename, change, or enable/disable a live resource', responses: { '200': { description: 'Resource updated' } } }, delete: { summary: 'Remove a live resource', responses: { '200': { description: 'Resource removed' } } } },
      '/api/agent/v1/vod/sources': { get: { summary: 'List VOD providers', responses: { '200': { description: 'Provider list' } } }, post: { summary: 'Add a probed Apple CMS/MacCMS provider', description: 'Requires AGENT_AUTONOMY=full. Accepts {name,api,kind?}.', responses: { '201': { description: 'Provider added' } } } },
      '/api/agent/v1/vod/sources/{id}': { patch: { summary: 'Update VOD provider fields or enabled state', responses: { '200': { description: 'Provider updated' } } }, delete: { summary: 'Remove VOD provider', responses: { '200': { description: 'Provider removed' } } } },
      '/api/agent/v1/vod/import': { post: { summary: 'Import a trusted JSON registry by URL or uploaded config object', description: 'Requires AGENT_AUTONOMY=full. Accepts {url} or {config,sourceName?}. Supported shapes: LibreTV sources[], MoonTV api_site{}, TVBox sites[].', responses: { '201': { description: 'Providers imported' } } } },
      '/api/agent/v1/vod/search': { get: { summary: 'Search VOD and public archive titles', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'movies', 'series', 'anime'] } }], responses: { '200': { description: 'VOD results' } } } },
    },
  });

  return {
    capabilities: gate('agent.capabilities', false, capabilities),
    status: gate('agent.status', false, status),
    auditLog: gate('agent.audit.read', false, auditLog),
    runTask: gate('agent.task.run', true, runTask),
    openApi: gate('agent.openapi.read', false, openApi),
    liveList: gate('agent.live.list', false, api.sourceList),
    liveAdd: gate('agent.live.add', true, api.addSource),
    liveUpdate: gate('agent.live.update', true, api.updateSource),
    liveDelete: gate('agent.live.delete', true, api.deleteSource),
    vodList: gate('agent.vod.list', false, api.listVodSources),
    vodAdd: gate('agent.vod.add', true, api.addVodSource),
    vodImport: gate('agent.vod.import', true, api.importVodSourceList),
    vodUpdate: gate('agent.vod.update', true, api.updateVodSource),
    vodDelete: gate('agent.vod.delete', true, api.deleteVodSource),
    vodSearch: gate('agent.vod.search', false, api.vodSearch),
    vodDetail: gate('agent.vod.detail', false, api.vodDetail),
    archiveSearch: gate('agent.archive.search', false, async (req, res, params, query) => {
      try {
        const type = ['all', 'movies', 'series', 'anime'].includes(query.type) ? query.type : 'all';
        const items = await archiveLib.search(query.q || '', type, 30);
        sendJson(req, res, 200, { total: items.length, items });
      } catch (err) {
        sendJson(req, res, err.statusCode || 502, { error: err.message || 'archive search failed' });
      }
    }),
  };
}
module.exports = { createAgentApi, matchesToken, safeUrlSummary };
