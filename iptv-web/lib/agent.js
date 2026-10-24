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
      '/api/agent/v1/capabilities': {
        get: { summary: 'Describe capabilities, limits, and autonomy policy', responses: { '200': { description: 'Capabilities' } } },
      },
      '/api/agent/v1/status': {
        get: { summary: 'Get live catalog, resource, provider, and automation status', responses: { '200': { description: 'Current service state' } } },
      },
      '/api/agent/v1/settings': {
        get: { summary: 'Read runtime automation settings', responses: { '200': { description: 'Settings' } } },
        patch: {
          summary: 'Update source registries, autonomy mode and automation schedules',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
            autonomy: { type: 'string', enum: ['full', 'review', 'off'] },
            automationEnabled: { type: 'boolean' },
            autoSourceSyncHours: { type: 'number', minimum: 1, maximum: 720 },
            refreshHours: { type: 'number', minimum: 1, maximum: 720 },
            sourceListUrls: { type: 'array', maxItems: 32, items: { type: 'string', format: 'uri' } },
          } } } } },
          responses: { '200': { description: 'Settings updated' } },
        },
      },
      '/api/agent/v1/audit': {
        get: { summary: 'Read recent agent and automation events', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { '200': { description: 'Audit entries' } } },
      },
      '/api/agent/v1/tasks/run': {
        post: { summary: 'Run a source-maintenance task', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['task'], properties: { task: { type: 'string', enum: ['maintain_sources', 'sync_source_lists', 'check_vod_providers', 'refresh_live_catalog'] } } } } } }, responses: { '200': { description: 'Task result' } } },
      },
      '/api/agent/v1/live/sources': {
        get: { summary: 'List live resources', responses: { '200': { description: 'Resource list' } } },
        post: { summary: 'Add and validate a live M3U/M3U8 source', responses: { '201': { description: 'Source added' } } },
      },
      '/api/agent/v1/live/sources/{id}': {
        patch: { summary: 'Update a live resource', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Source updated' } } },
        delete: { summary: 'Delete a live resource', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Source deleted' } } },
      },
      '/api/agent/v1/vod/sources': {
        get: { summary: 'List VOD providers', responses: { '200': { description: 'Provider list' } } },
        post: { summary: 'Add and probe a VOD provider', responses: { '201': { description: 'Provider added' } } },
      },
      '/api/agent/v1/vod/sources/{id}': {
        patch: { summary: 'Update a VOD provider', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Provider updated' } } },
        delete: { summary: 'Delete a VOD provider', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Provider deleted' } } },
      },
      '/api/agent/v1/vod/import': {
        post: { summary: 'Import compatible live and VOD registry sources from JSON', responses: { '201': { description: 'Import report' } } },
      },
      '/api/agent/v1/vod/search': {
        get: { summary: 'Search configured VOD, Internet Archive and Wikimedia Commons catalogs', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'movies', 'series', 'anime'] } }], responses: { '200': { description: 'Search results' } } },
      },
      '/api/agent/v1/archive/search': {
        get: { summary: 'Search Internet Archive public-domain/CC candidates', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Archive results' } } },
      },
      '/api/agent/v1/commons/search': {
        get: { summary: 'Search Wikimedia Commons open-license video', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'movies', 'anime'] } }], responses: { '200': { description: 'Commons results' } } },
      },
      '/api/agent/v1/project/status': {
        get: { summary: 'Inspect GitHub repository configuration, permissions and workflows', responses: { '200': { description: 'Repository status' }, '503': { description: 'GitHub token not configured' } } },
      },
      '/api/agent/v1/project/tree': {
        get: { summary: 'List repository files and folders', parameters: [{ name: 'path', in: 'query', schema: { type: 'string' } }, { name: 'ref', in: 'query', schema: { type: 'string' } }, { name: 'recursive', in: 'query', schema: { type: 'boolean' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100000 } }], responses: { '200': { description: 'Git tree' } } },
      },
      '/api/agent/v1/project/file': {
        get: { summary: 'Read any tracked repository file', parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }, { name: 'ref', in: 'query', schema: { type: 'string' } }, { name: 'encoding', in: 'query', schema: { type: 'string', enum: ['utf8', 'base64'] } }], responses: { '200': { description: 'File content and SHA' } } },
      },
      '/api/agent/v1/project/commit': {
        post: {
          summary: 'Commit multi-file edits or deletions to a repository branch',
          description: 'The authenticated project agent may change any tracked file, including UI assets, backend code, tests, documentation, dependencies and workflow files. It can create a feature branch and PR in the same operation.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message', 'changes'], properties: {
            message: { type: 'string' }, branch: { type: 'string' }, baseBranch: { type: 'string' },
            createPullRequest: { type: 'boolean' }, pullRequestTitle: { type: 'string' }, pullRequestBody: { type: 'string' }, draft: { type: 'boolean' },
            changes: { type: 'array', minItems: 1, items: { type: 'object', required: ['path'], properties: {
              path: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'delete'] },
              content: { type: 'string' }, mode: { type: 'string', enum: ['100644', '100755', '120000'] },
            } } },
          } } } } },
          responses: { '201': { description: 'Commit and optional PR details' } },
        },
      },
      '/api/agent/v1/project/branch': {
        post: { summary: 'Create or reuse a branch', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, base: { type: 'string' } } } } } }, responses: { '201': { description: 'Branch result' } } },
      },
      '/api/agent/v1/project/pr': {
        post: { summary: 'Create a pull request', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['head', 'title'], properties: { head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Pull request created' } } },
      },
      '/api/agent/v1/project/pr/{number}/merge': {
        post: { summary: 'Merge a pull request after validation', parameters: [{ name: 'number', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commitTitle: { type: 'string' }, commitMessage: { type: 'string' } } } } } }, responses: { '200': { description: 'PR merged' }, '409': { description: 'Merge unavailable or checks failed' } } },
      },
      '/api/agent/v1/project/dispatch': {
        post: { summary: 'Dispatch a configured GitHub Actions or deployment workflow', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['workflow'], properties: { workflow: { type: 'string' }, ref: { type: 'string' }, inputs: { type: 'object', additionalProperties: { type: 'string' } } } } } } }, responses: { '202': { description: 'Workflow dispatched' } } },
      },
      '/api/agent/v1/project/actions': {
        get: { summary: 'Inspect CI and deployment workflow runs', parameters: [{ name: 'branch', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }], responses: { '200': { description: 'Workflow runs' } } },
      },
      '/api/agent/v1/project/checks/{sha}': {
        get: { summary: 'Inspect commit checks', parameters: [{ name: 'sha', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{7,64}$' } }], responses: { '200': { description: 'Commit checks' } },
      },
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
 } }], responses: { '200': { description: 'Commit checks' } } } },
      '/api/agent/v1/capabilities': { get: { summary: 'Describe capabilities, limits and autonomy policy', responses: { '200': { description: 'Capabilities' } } } },
      '/api/agent/v1/status': { get: { summary: 'Get health, catalog and source status', responses: { '200': { description: 'Current service state' } } } },
      '/api/agent/v1/project/status': { get: { summary: 'Inspect repository settings, default branch, and available workflows', responses: { '200': { description: 'Repository state' }, '503': { description: 'GITHUB_REPO_TOKEN is not configured' } } } },
      '/api/agent/v1/project/tree': { get: { summary: 'List every tracked repository path', parameters: [{ name: 'path', in: 'query', schema: { type: 'string' } }, { name: 'ref', in: 'query', schema: { type: 'string' } }, { name: 'recursive', in: 'query', schema: { type: 'boolean' } }], responses: { '200': { description: 'Repository tree' } } } },
      '/api/agent/v1/project/file': { get: { summary: 'Read any repository file, including hidden files and workflow definitions', parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }, { name: 'ref', in: 'query', schema: { type: 'string' } }, { name: 'encoding', in: 'query', schema: { type: 'string', enum: ['utf8', 'base64'] } }], responses: { '200': { description: 'File content and blob SHA' } } } },
      '/api/agent/v1/project/commit': { post: { summary: 'Create a multi-file commit on any repository branch', description: 'Creates, updates or deletes any tracked project file, including application code, tests, docs, dependencies and workflow definitions. Defaults to the configured branch. Set createPullRequest=true to create a branch and PR in one call.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message', 'changes'], properties: { message: { type: 'string' }, branch: { type: 'string' }, baseBranch: { type: 'string' }, createPullRequest: { type: 'boolean' }, pullRequestTitle: { type: 'string' }, pullRequestBody: { type: 'string' }, draft: { type: 'boolean' }, changes: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, action: { type: 'string', enum: ['upsert', 'delete'] }, content: { type: 'string' }, mode: { type: 'string', enum: ['100644', '100755', '120000'] } } } } } } } } }, responses: { '201': { description: 'Commit and optional PR details' } } } },
      '/api/agent/v1/project/branch': { post: { summary: 'Create a branch from any available ref', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, base: { type: 'string' } } } } } }, responses: { '201': { description: 'Branch created or already present' } } } },
      '/api/agent/v1/project/pr': { post: { summary: 'Create a pull request', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['head', 'title'], properties: { head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, draft: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Pull request created' } } } },
      '/api/agent/v1/project/pr/{number}/merge': { post: { summary: 'Merge a pull request using the requested merge method', requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commitTitle: { type: 'string' }, commitMessage: { type: 'string' } } } } } }, responses: { '200': { description: 'PR merged' }, '409': { description: 'Merge unavailable or checks/branch rules not satisfied' } } } },
      '/api/agent/v1/project/dispatch': { post: { summary: 'Dispatch any GitHub Actions workflow with inputs', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['workflow'], properties: { workflow: { type: 'string' }, ref: { type: 'string' }, inputs: { type: 'object', additionalProperties: { type: 'string' } } } } } } }, responses: { '202': { description: 'Workflow dispatch accepted' } } } },
      '/api/agent/v1/project/actions': { get: { summary: 'Inspect GitHub Actions runs', parameters: [{ name: 'branch', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }], responses: { '200': { description: 'Workflow runs' } } } },
      '/api/agent/v1/project/checks/{sha}': { get: { summary: 'Inspect check suites and CI status for a commit', responses: { '200': { description: 'Commit checks' } } } },
      '/api/agent/v1/settings': { get: { summary: 'Read runtime automation settings', responses: { '200': { description: 'Settings' } } }, patch: { summary: 'Update runtime automation settings and trusted registry URLs', description: 'Available to the authenticated project agent. Cannot change secrets; URLs and intervals are validated.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { autonomy: { type: 'string', enum: ['full', 'review', 'off'] }, automationEnabled: { type: 'boolean' }, autoSourceSyncHours: { type: 'number', minimum: 1, maximum: 720 }, refreshHours: { type: 'number', minimum: 1, maximum: 720 }, sourceListUrls: { type: 'array', maxItems: 32, items: { type: 'string', format: 'uri' } } } } } } }, responses: { '200': { description: 'Updated settings' } } } },
      '/api/agent/v1/commons/search': { get: { summary: 'Search Wikimedia Commons for directly playable open-license videos', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'movies', 'anime'] } }], responses: { '200': { description: 'Open-license Commons video results with license metadata' } } } },
      '/api/agent/v1/audit': { get: { summary: 'Read recent agent and automation actions', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }], responses: { '200': { description: 'Audit entries' } } } },
      '/api/agent/v1/tasks/run': { post: { summary: 'Run a maintenance task', description: 'Available to the authenticated project agent. Allowed tasks: maintain_sources, sync_source_lists, check_vod_providers, refresh_live_catalog.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['task'], properties: { task: { type: 'string', enum: ['maintain_sources', 'sync_source_lists', 'check_vod_providers', 'refresh_live_catalog'] } } } } } }, responses: { '200': { description: 'Task result' }, '423': { description: 'Writes blocked by autonomy policy' } } } },
      '/api/agent/v1/live/sources': { get: { summary: 'List configured M3U resources', responses: { '200': { description: 'Resource list' } } }, post: { summary: 'Add and validate a live M3U/M3U8 resource', description: 'Available to the authenticated project agent. Accepts {name,url,enabled?}.', responses: { '201': { description: 'Resource added' } } } },
      '/api/agent/v1/live/sources/{id}': { patch: { summary: 'Rename, change, or enable/disable a live resource', responses: { '200': { description: 'Resource updated' } } }, delete: { summary: 'Remove a live resource', responses: { '200': { description: 'Resource removed' } } } },
      '/api/agent/v1/vod/sources': { get: { summary: 'List VOD providers', responses: { '200': { description: 'Provider list' } } }, post: { summary: 'Add a probed Apple CMS/MacCMS provider', description: 'Available to the authenticated project agent. Accepts {name,api,kind?}.', responses: { '201': { description: 'Provider added' } } } },
      '/api/agent/v1/vod/sources/{id}': { patch: { summary: 'Update VOD provider fields or enabled state', responses: { '200': { description: 'Provider updated' } } }, delete: { summary: 'Remove VOD provider', responses: { '200': { description: 'Provider removed' } } } },
      '/api/agent/v1/vod/import': { post: { summary: 'Import a trusted JSON registry by URL or uploaded config object', description: 'Available to the authenticated project agent. Accepts {url} or {config,sourceName?}. Imports both VOD sources[]/api_site{} / sites[] and liveSources[] M3U entries; validates URLs and probes candidates before saving.', responses: { '201': { description: 'Providers imported' } } } },
      '/api/agent/v1/vod/search': { get: { summary: 'Search configured VOD, Internet Archive and Wikimedia Commons titles', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['all', 'movies', 'series', 'anime'] } }], responses: { '200': { description: 'VOD results' } } } },
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
