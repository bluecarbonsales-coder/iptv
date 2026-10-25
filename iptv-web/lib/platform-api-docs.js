'use strict';

// One plain route list powers the API overview and OpenAPI JSON at /api/v1.
const ROUTES = [
  ['GET', '/', 'API index and available groups', 'General', 'public'],
  ['GET', '/openapi.json', 'OpenAPI definition for the whole platform', 'General', 'public'],
  ['GET', '/health', 'Application health and catalogue counts', 'General', 'public'],

  ['GET', '/sources', 'List all Radio, IPTV and Theatre sources', 'Sources', 'admin'],
  ['GET', '/sources/health', 'Check configured source availability and server-proxy latency', 'Sources', 'admin'],
  ['GET', '/sources/{type}', 'List sources of one type: radio, iptv, or theatre', 'Sources', 'admin'],
  ['POST', '/sources/{type}', 'Add a source to Radio, IPTV, or Theatre', 'Sources', 'admin'],
  ['POST', '/sources/{type}/enable-all', 'Enable every source of one type', 'Sources', 'admin'],
  ['POST', '/sources/theatre/import', 'Import a Theatre provider-list JSON URL or configuration', 'Sources', 'admin'],
  ['PATCH', '/sources/{type}/{id}', 'Edit or enable/disable one source', 'Sources', 'admin'],
  ['DELETE', '/sources/{type}/{id}', 'Delete one source', 'Sources', 'admin'],

  ['GET', '/iptv/meta', 'IPTV catalogue facets and counts', 'IPTV', 'public'],
  ['GET', '/iptv/channels', 'Search and filter IPTV channels', 'IPTV', 'public'],
  ['GET', '/iptv/channels/{id}', 'Get a channel and its stream URLs', 'IPTV', 'public'],
  ['GET', '/iptv/playlist', 'Fetch and parse an external M3U playlist URL', 'IPTV', 'public'],
  ['GET', '/iptv/playlist.m3u', 'Return an external playlist through the HLS relay', 'IPTV', 'public'],
  ['GET', '/iptv/export.m3u', 'Export the filtered IPTV catalogue as M3U', 'IPTV', 'public'],
  ['GET', '/iptv/hls', 'Relay HLS manifests and segments for playback', 'IPTV', 'public'],
  ['GET', '/iptv/image', 'Load a channel logo through the image cache', 'IPTV', 'public'],
  ['POST', '/iptv/refresh', 'Refresh the IPTV catalogue now', 'IPTV', 'admin'],

  ['GET', '/radio/stations', 'Search radio stations by name, language, country, genre and codec', 'Radio', 'public'],
  ['GET', '/radio/options', 'Get radio country, language or genre options', 'Radio', 'public'],
  ['GET', '/radio/resolve/{uuid}', 'Resolve a radio station playback URL', 'Radio', 'public'],
  ['GET', '/radio/stream/{ticket}', 'Play a resolved radio stream through a short-lived relay ticket', 'Radio', 'public'],

  ['GET', '/theatre/titles', 'Search movies, series, anime and documentaries', 'Theatre', 'public'],
  ['GET', '/theatre/titles/{sourceId}/{vodId}', 'Get a Theatre title and its playable episodes', 'Theatre', 'public'],

  ['GET', '/portal/services', 'List homepage service shortcuts', 'Portal', 'public'],
  ['GET', '/portal/availability', 'Check homepage service availability', 'Portal', 'public'],
  ['POST', '/portal/services', 'Add a homepage shortcut', 'Portal', 'admin'],
  ['PATCH', '/portal/services/{id}', 'Edit a homepage shortcut', 'Portal', 'admin'],
  ['DELETE', '/portal/services/{id}', 'Delete a homepage shortcut', 'Portal', 'admin'],
  ['GET', '/navigation', 'Read navigation settings', 'Portal', 'admin'],
  ['PUT', '/navigation', 'Save navigation settings', 'Portal', 'admin'],

  ['GET', '/metadata/search', 'Search film and TV metadata', 'Metadata', 'public'],
  ['GET', '/metadata/tvmaze', 'Search TVMaze metadata', 'Metadata', 'public'],
  ['GET', '/metadata/title', 'Get enriched metadata for a title', 'Metadata', 'public'],
  ['GET', '/history/{visitorId}', 'Read local playback and search history', 'Visitor', 'public'],
  ['POST', '/history/{visitorId}', 'Record a playback or search event', 'Visitor', 'public'],
  ['POST', '/visitor/context', 'Submit optional coarse resource-discovery context', 'Visitor', 'public'],

  ['GET', '/mail/session', 'Check the current Mail Workspace session', 'Mail', 'mail'],
  ['POST', '/mail/login', 'Sign in to a Mail Workspace account', 'Mail', 'public'],
  ['POST', '/mail/logout', 'Sign out of Mail Workspace', 'Mail', 'mail'],
  ['GET', '/mail/accounts', 'List configured mailboxes', 'Mail', 'mail'],
  ['POST', '/mail/accounts', 'Add a mailbox', 'Mail', 'mail'],
  ['POST', '/mail/accounts/bulk-password', 'Update mailbox passwords', 'Mail', 'mail'],
  ['DELETE', '/mail/accounts/{id}', 'Remove a mailbox', 'Mail', 'mail'],
  ['POST', '/mail/accounts/{id}/test', 'Test a mailbox connection', 'Mail', 'mail'],
  ['GET', '/mail/folders', 'List mailbox folders', 'Mail', 'mail'],
  ['GET', '/mail/messages', 'List messages in a folder', 'Mail', 'mail'],
  ['GET', '/mail/message', 'Read one email', 'Mail', 'mail'],
  ['POST', '/mail/send', 'Send an email', 'Mail', 'mail'],
  ['GET', '/mail/drafts', 'List email drafts', 'Mail', 'mail'],
  ['POST', '/mail/drafts', 'Create an email draft', 'Mail', 'mail'],
  ['DELETE', '/mail/drafts/{id}', 'Delete a draft', 'Mail', 'mail'],
  ['POST', '/mail/drafts/{id}/send', 'Send a draft', 'Mail', 'mail'],
  ['GET', '/mail/contacts', 'List contacts', 'Mail', 'mail'],
  ['POST', '/mail/contacts', 'Add a contact', 'Mail', 'mail'],
  ['PATCH', '/mail/contacts/{id}', 'Edit a contact', 'Mail', 'mail'],
  ['DELETE', '/mail/contacts/{id}', 'Delete a contact', 'Mail', 'mail'],
  ['GET', '/mail/audit', 'Read the Mail Workspace audit log', 'Mail', 'mail'],

  ['GET', '/agent/capabilities', 'Get agent capabilities and source limits', 'Agent', 'admin'],
  ['GET', '/agent/status', 'Get catalogue, provider and automation status', 'Agent', 'admin'],
  ['GET', '/agent/settings', 'Read automation settings', 'Agent', 'admin'],
  ['PATCH', '/agent/settings', 'Change automation settings', 'Agent', 'admin'],
  ['GET', '/agent/audit', 'Read the agent and automation audit log', 'Agent', 'admin'],
  ['POST', '/agent/tasks/run', 'Run source checks or catalogue maintenance', 'Agent', 'admin'],
  ['GET', '/agent/sources/iptv', 'List configured IPTV playlist sources', 'Agent', 'admin'],
  ['POST', '/agent/sources/iptv', 'Add an IPTV playlist source', 'Agent', 'admin'],
  ['PATCH', '/agent/sources/iptv/{id}', 'Edit an IPTV playlist source', 'Agent', 'admin'],
  ['DELETE', '/agent/sources/iptv/{id}', 'Delete an IPTV playlist source', 'Agent', 'admin'],
  ['GET', '/agent/sources/theatre', 'List Theatre providers', 'Agent', 'admin'],
  ['POST', '/agent/sources/theatre', 'Add a Theatre provider', 'Agent', 'admin'],
  ['POST', '/agent/sources/theatre/import', 'Import Theatre providers', 'Agent', 'admin'],
  ['PATCH', '/agent/sources/theatre/{id}', 'Edit a Theatre provider', 'Agent', 'admin'],
  ['DELETE', '/agent/sources/theatre/{id}', 'Delete a Theatre provider', 'Agent', 'admin'],
  ['GET', '/agent/theatre/search', 'Search configured and open-license movie sources', 'Agent', 'admin'],
  ['GET', '/agent/theatre/titles/{sourceId}/{vodId}', 'Get a Theatre title and its episodes as an agent', 'Agent', 'admin'],
  ['GET', '/agent/theatre/archive/search', 'Search Internet Archive open-license candidates', 'Agent', 'admin'],
  ['GET', '/agent/theatre/commons/search', 'Search Wikimedia Commons open-license videos', 'Agent', 'admin'],
  ['GET', '/agent/navigation', 'Read editable navigation configuration', 'Agent', 'admin'],
  ['PUT', '/agent/navigation', 'Replace navigation configuration', 'Agent', 'admin'],
  ['GET', '/agent/portal/services', 'List homepage shortcuts for an agent', 'Agent', 'admin'],
  ['POST', '/agent/portal/services', 'Add homepage shortcuts as an agent', 'Agent', 'admin'],
  ['PATCH', '/agent/portal/services/{id}', 'Edit homepage shortcuts as an agent', 'Agent', 'admin'],
  ['DELETE', '/agent/portal/services/{id}', 'Delete homepage shortcuts as an agent', 'Agent', 'admin'],
  ['GET', '/agent/discovery/visitor-trends', 'Get aggregate discovery trends', 'Agent', 'admin'],
  ['GET', '/agent/project/status', 'Check repository and workflow status', 'Agent', 'admin'],
  ['GET', '/agent/project/tree', 'Browse the repository tree', 'Agent', 'admin'],
  ['GET', '/agent/project/file', 'Read a repository file', 'Agent', 'admin'],
  ['POST', '/agent/project/commit', 'Commit project file changes', 'Agent', 'admin'],
  ['POST', '/agent/project/branch', 'Create a project branch', 'Agent', 'admin'],
  ['POST', '/agent/project/pr', 'Create a pull request', 'Agent', 'admin'],
  ['POST', '/agent/project/pr/{number}/merge', 'Merge a pull request', 'Agent', 'admin'],
  ['POST', '/agent/project/dispatch', 'Run a configured workflow', 'Agent', 'admin'],
  ['GET', '/agent/project/actions', 'Read CI/deployment runs', 'Agent', 'admin'],
  ['GET', '/agent/project/checks/{sha}', 'Read commit checks', 'Agent', 'admin'],
  ['GET', '/agent/mail/accounts', 'List mailboxes for a trusted agent', 'Agent', 'admin'],
  ['GET', '/agent/mail/folders', 'List mailbox folders for a trusted agent', 'Agent', 'admin'],
  ['GET', '/agent/mail/messages', 'List messages for a trusted agent', 'Agent', 'admin'],
  ['GET', '/agent/mail/message', 'Read a message for a trusted agent', 'Agent', 'admin'],
  ['GET', '/agent/mail/contacts', 'List contacts for a trusted agent', 'Agent', 'admin'],
  ['GET', '/agent/mail/drafts', 'List drafts for a trusted agent', 'Agent', 'admin'],
  ['POST', '/agent/mail/drafts', 'Create a draft for a trusted agent', 'Agent', 'admin'],
  ['POST', '/agent/mail/drafts/{id}/send', 'Send an approved draft for a trusted agent', 'Agent', 'admin'],
];

function describeApi() {
  const groups = {};
  for (const route of ROUTES) {
    const [method, path, summary, group, auth] = route;
    if (!groups[group]) groups[group] = [];
    groups[group].push({ method, path: path === '/' ? '/api/v1' : '/api/v1' + path, summary, auth });
  }
  return {
    name: 'IPTV Web Platform API',
    version: '1.0.0',
    basePath: '/api/v1',
    openapi: '/api/v1/openapi.json',
    authentication: {
      public: 'No login required for public read and playback endpoints.',
      admin: 'Use HTTP Basic authentication with the admin username and password used by /admin.html (defaults: admin / 0809).',
      mail: 'Use the Mail Workspace login and its session cookie.',
      agent: 'Unified /api/v1/agent endpoints use the same admin login. Legacy token-only /api/agent/v1 endpoints are disabled.',
    },
    groups: Object.entries(groups).map(([name, endpoints]) => ({ name, endpoints })),
  };
}

function buildOpenApi() {
  const paths = {};
  for (const [method, routePath, summary, group, auth] of ROUTES) {
    const key = routePath === '/' ? '/' : routePath;
    if (!paths[key]) paths[key] = {};
    const operation = {
      operationId: method.toLowerCase() + key.split('/').filter(Boolean).map((part) => part.replace(/[{}]/g, '')).map((part) => part.replace(/[^a-zA-Z0-9]/g, '-')).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(''),
      summary,
      tags: [group],
      responses: { '200': { description: 'Request completed.' }, '400': { description: 'Invalid request.' }, '401': { description: 'Authentication required.' }, '500': { description: 'Server error.' } },
    };
    if (auth === 'admin') operation.security = [{ AdminLogin: [] }];
    if (auth === 'mail') {
      operation.description = summary + '. Uses the Mail Workspace session after POST /mail/login.';
      operation.security = [{ MailSession: [] }];
    }
    const pathParameters = [...key.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    if (pathParameters.length) operation.parameters = pathParameters;
    const bodyOptional = new Set(['/sources/{type}/enable-all', '/iptv/refresh', '/mail/logout']);
    if (['POST', 'PATCH', 'PUT'].includes(method) && !key.includes('/openapi.json') && !bodyOptional.has(key)) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      };
    }
    paths[key][method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'IPTV Web Platform API',
      version: '1.0.0',
      description: 'One API entry point for Radio, IPTV, Theatre, source management, portal settings, metadata, Mail Workspace and advanced agent tools.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        AdminLogin: { type: 'http', scheme: 'basic', description: 'Use the same username and password as /admin.html.' },
        MailSession: { type: 'apiKey', in: 'cookie', name: 'mail_workspace_session', description: 'Log in through POST /mail/login first.' },
      },
    },
    paths,
  };
}

module.exports = { ROUTES, describeApi, buildOpenApi };
