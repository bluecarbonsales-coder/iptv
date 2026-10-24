'use strict';
const crypto = require('crypto');
const { sendJson, readBody } = require('./util');
const vodLib = require('./vod');
const archiveLib = require('./archive-vod');
const commonsLib = require('./commons-vod');
const sourceLib = require('./sources');
const { createGitHubProject } = require('./github-project');

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
  const project = createGitHubProject();
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
      // The dedicated AGENT_API_TOKEN grants the agent the owner's project-management authority.
      // AGENT_AUTONOMY controls the background import policy, not authenticated interactive writes.
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
        'discover public-domain / CC films through Internet Archive',
        'discover open-license video files through Wikimedia Commons',
        'import configured LibreTV/MoonTV/TVBox-compatible provider registries',
        'add, update, enable, disable, and delete providers',
        'run source checks and scheduled maintenance',
        'refresh the live IPTV catalogue',
        'read an audit history of agent/automation actions',
        'read and change any tracked repository file through GitHub',
        'create branches, commits, pull requests, merge changes, inspect checks, and dispatch GitHub Actions workflows',
        'trigger deployment workflows when configured in the repository',
      ],
      autonomy: {
        mode: automation.status().autonomy,
        writeEnabled: true,
        allowedRegistryUrls: automation.status().configuredRegistryCount,
        warning: 'The TVboxorg availability-probed registry is configured by default on fresh deployments. Additional registries are agent-managed; imported API endpoints are probed before activation in full mode. Compatibility probes do not establish content rights.',
      },
      sources: {
        live: 'iptv-org catalogue plus explicitly configured M3U/M3U8 resources',
        vod: 'Configured Apple CMS/MacCMS API endpoints',
        publicDomain: 'Internet Archive and Wikimedia Commons media records filtered by their declared open-license metadata',
        importFormats: ['LibreTV SourceList JSON: sources[]', 'MoonTV config.json: api_site{}', 'TVBox-style JSON: sites[]'],
      },
      project: {
        repository: project.repository,
        configured: project.configured(),
        fullRepositoryEditing: true,
        capabilities: ['status', 'tree', 'file read', 'multi-file commits to any branch', 'branch creation', 'pull requests', 'merge pull requests', 'workflow dispatch', 'CI check inspection'],
        configurationHint: project.configured() ? null : 'Set GITHUB_REPO_TOKEN with repository contents, pull-request, and Actions write permissions to activate code/deployment operations.',
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

  const settingsView = (req, res) => {
    const current = automation.getSettings();
    sendJson(req, res, 200, {
      ...current,
      sourceListUrls: (current.sourceListUrls || []).map(safeUrlSummary),
      mutableFields: ['autonomy', 'automationEnabled', 'autoSourceSyncHours', 'refreshHours', 'sourceListUrls'],
      note: 'AGENT_API_TOKEN and other secrets are deployment-only and cannot be changed through this endpoint.',
    });
  };

  const settingsUpdate = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 65536));
      const allowed = new Set(['autonomy', 'automationEnabled', 'autoSourceSyncHours', 'refreshHours', 'sourceListUrls']);
      const unknown = Object.keys(body).filter((key) => !allowed.has(key));
      if (unknown.length) return sendJson(req, res, 400, { error: 'unknown or immutable setting fields', fields: unknown });
      const updated = await automation.updateSettings(body, 'agent');
      sendJson(req, res, 200, {
        ok: true,
        settings: { ...updated, sourceListUrls: updated.sourceListUrls.map(safeUrlSummary) },
        automation: automation.status(),
      });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'settings update failed' });
    }
  };

  const projectStatus = async (req, res) => {
    try {
      sendJson(req, res, 200, { ...await project.status(), configured: true, fullRepositoryEditing: true });
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not inspect project repository', configured: project.configured(), repository: project.repository });
    }
  };
  const projectTree = async (req, res, params, query) => {
    try {
      sendJson(req, res, 200, await project.tree({
        path: query.path || '',
        ref: query.ref || project.defaultBranch,
        recursive: query.recursive !== 'false',
        limit: query.limit,
      }));
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not list repository files' });
    }
  };
  const projectFile = async (req, res, params, query) => {
    try {
      const result = await project.file({
        path: query.path,
        ref: query.ref || project.defaultBranch,
        base64: query.encoding === 'base64',
      });
      sendJson(req, res, 200, result);
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not read repository file' });
    }
  };
  const projectCommit = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 32 * 1024 * 1024));
      let branch = body.branch;
      if (body.createPullRequest && !branch) branch = 'agent/autonomous-' + new Date().toISOString().replace(/[^0-9TZ]/g, '-');
      const result = await project.commitChanges({ ...body, branch });
      let pullRequest = null;
      if (body.createPullRequest) {
        const base = body.baseBranch || project.defaultBranch;
        pullRequest = await project.pullRequest({
          head: result.branch,
          base,
          title: body.pullRequestTitle || body.message || 'Autonomous project update',
          body: body.pullRequestBody || ('Automated change by the authenticated IPTV Web project agent.\n\nCommit: ' + result.commitUrl),
          draft: !!body.draft,
        });
      }
      automation.audit({
        actor: 'agent',
        action: 'project.commit',
        status: 'ok',
        summary: 'Committed ' + result.changedFiles.length + ' file change(s) to ' + result.branch + ' (' + result.commit.slice(0, 12) + ')',
      });
      sendJson(req, res, 201, { ok: true, ...result, pullRequest });
    } catch (err) {
      automation.audit({ actor: 'agent', action: 'project.commit', status: 'error', summary: String(err.message || err).slice(0, 300) });
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'repository commit failed' });
    }
  };
  const projectBranch = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 16384));
      sendJson(req, res, 201, await project.createBranch({ name: body.name, base: body.base || project.defaultBranch }));
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'branch creation failed' });
    }
  };
  const projectPullRequest = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 65536));
      sendJson(req, res, 201, await project.pullRequest(body));
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'pull request creation failed' });
    }
  };
  const projectMerge = async (req, res, params) => {
    try {
      const body = JSON.parse(await readBody(req, 65536).catch(() => '{}'));
      const result = await project.mergePullRequest({ ...body, number: params.number });
      automation.audit({ actor: 'agent', action: 'project.merge', status: result.merged ? 'ok' : 'error', summary: 'Pull request #' + params.number + ': ' + (result.message || (result.merged ? 'merged' : 'not merged')) });
      sendJson(req, res, result.merged ? 200 : 409, result);
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'pull request merge failed' });
    }
  };
  const projectDispatch = async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req, 65536));
      const result = await project.dispatchWorkflow(body);
      automation.audit({ actor: 'agent', action: 'project.workflow_dispatch', status: 'ok', summary: 'Dispatched ' + String(body.workflow).slice(0, 120) + ' on ' + String(body.ref || project.defaultBranch).slice(0, 120) });
      sendJson(req, res, 202, result);
    } catch (err) {
      automation.audit({ actor: 'agent', action: 'project.workflow_dispatch', status: 'error', summary: String(err.message || err).slice(0, 300) });
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'workflow dispatch failed' });
    }
  };
  const projectActions = async (req, res, params, query) => {
    try {
      sendJson(req, res, 200, await project.actions({ branch: query.branch || project.defaultBranch, limit: query.limit }));
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not list workflow runs' });
    }
  };
  const projectChecks = async (req, res, params) => {
    try {
      sendJson(req, res, 200, await project.commitStatus(params.sha));
    } catch (err) {
      sendJson(req, res, err.statusCode || 502, { error: err.message || 'could not inspect commit checks' });
    }
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
      "/api/agent/v1/capabilities": { get: { summary: "Describe capabilities, limits and autonomy policy", responses: { '200': { description: "GET /api/agent/v1/capabilities" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/status": { get: { summary: "Get live catalog, resource, provider and automation status", responses: { '200': { description: "GET /api/agent/v1/status" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/settings": { get: { summary: "Read runtime automation settings", responses: { '200': { description: "GET /api/agent/v1/settings" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/settings": { patch: { summary: "Update runtime schedules, autonomy and source registry URLs", responses: { '200': { description: "PATCH /api/agent/v1/settings" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/audit": { get: { summary: "Read agent and automation audit entries", responses: { '200': { description: "GET /api/agent/v1/audit" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/tasks/run": { post: { summary: "Run a source maintenance or catalog refresh task", responses: { '200': { description: "POST /api/agent/v1/tasks/run" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/live/sources": { get: { summary: "List live resources", responses: { '200': { description: "GET /api/agent/v1/live/sources" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/live/sources": { post: { summary: "Add and validate a live M3U/M3U8 source", responses: { '200': { description: "POST /api/agent/v1/live/sources" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/live/sources/{id}": { patch: { summary: "Update a live resource", responses: { '200': { description: "PATCH /api/agent/v1/live/sources/{id}" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/live/sources/{id}": { delete: { summary: "Delete a live resource", responses: { '200': { description: "DELETE /api/agent/v1/live/sources/{id}" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/sources": { get: { summary: "List VOD providers", responses: { '200': { description: "GET /api/agent/v1/vod/sources" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/sources": { post: { summary: "Add and probe a VOD provider", responses: { '200': { description: "POST /api/agent/v1/vod/sources" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/sources/{id}": { patch: { summary: "Update a VOD provider", responses: { '200': { description: "PATCH /api/agent/v1/vod/sources/{id}" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/sources/{id}": { delete: { summary: "Delete a VOD provider", responses: { '200': { description: "DELETE /api/agent/v1/vod/sources/{id}" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/import": { post: { summary: "Import compatible live and VOD sources from a JSON registry", responses: { '200': { description: "POST /api/agent/v1/vod/import" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/vod/search": { get: { summary: "Search configured VOD and built-in public-license catalogs", responses: { '200': { description: "GET /api/agent/v1/vod/search" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/archive/search": { get: { summary: "Search Internet Archive open-license candidates", responses: { '200': { description: "GET /api/agent/v1/archive/search" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/commons/search": { get: { summary: "Search Wikimedia Commons open-license video", responses: { '200': { description: "GET /api/agent/v1/commons/search" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/status": { get: { summary: "Inspect repository permissions and workflow configuration", responses: { '200': { description: "GET /api/agent/v1/project/status" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/tree": { get: { summary: "List repository files and folders", responses: { '200': { description: "GET /api/agent/v1/project/tree" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/file": { get: { summary: "Read any tracked repository file", responses: { '200': { description: "GET /api/agent/v1/project/file" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/commit": { post: { summary: "Create multi-file edits/deletions across the entire repository; optionally open a PR", responses: { '200': { description: "POST /api/agent/v1/project/commit" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/branch": { post: { summary: "Create a project branch", responses: { '200': { description: "POST /api/agent/v1/project/branch" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/pr": { post: { summary: "Create a pull request", responses: { '200': { description: "POST /api/agent/v1/project/pr" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/pr/{number}/merge": { post: { summary: "Merge a pull request after validation", responses: { '200': { description: "POST /api/agent/v1/project/pr/{number}/merge" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/dispatch": { post: { summary: "Trigger a configured GitHub Actions or deployment workflow", responses: { '200': { description: "POST /api/agent/v1/project/dispatch" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/actions": { get: { summary: "Inspect CI and deployment runs", responses: { '200': { description: "GET /api/agent/v1/project/actions" }, '201': { description: 'Operation completed' } } } },
      "/api/agent/v1/project/checks/{sha}": { get: { summary: "Inspect commit checks", responses: { '200': { description: "GET /api/agent/v1/project/checks/{sha}" }, '201': { description: 'Operation completed' } } } },
    },
  });

  return {
    capabilities: gate('agent.capabilities', false, capabilities),
    projectStatus: gate('agent.project.status', false, projectStatus),
    projectTree: gate('agent.project.tree', false, projectTree),
    projectFile: gate('agent.project.file', false, projectFile),
    projectCommit: gate('agent.project.commit', true, projectCommit),
    projectBranch: gate('agent.project.branch', true, projectBranch),
    projectPullRequest: gate('agent.project.pr', true, projectPullRequest),
    projectMerge: gate('agent.project.merge', true, projectMerge),
    projectDispatch: gate('agent.project.workflow_dispatch', true, projectDispatch),
    projectActions: gate('agent.project.actions', false, projectActions),
    projectChecks: gate('agent.project.checks', false, projectChecks),
    status: gate('agent.status', false, status),
    settingsView: gate('agent.settings.read', false, settingsView),
    settingsUpdate: gate('agent.settings.update', true, settingsUpdate),
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
    commonsSearch: gate('agent.commons.search', false, async (req, res, params, query) => {
      try {
        const type = ['all', 'movies', 'anime'].includes(query.type) ? query.type : 'all';
        const items = await commonsLib.search(query.q || '', type, 25);
        sendJson(req, res, 200, { total: items.length, items });
      } catch (err) {
        sendJson(req, res, err.statusCode || 502, { error: err.message || 'Commons search failed' });
      }
    }),
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
