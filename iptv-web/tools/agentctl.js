#!/usr/bin/env node
'use strict';
// Dependency-free CLI for Hermes and other trusted agents. It uses only the documented agent API.
const DEFAULT_BASE = process.env.IPTV_BASE_URL || 'http://127.0.0.1:3920';
const TOKEN = process.env.AGENT_API_TOKEN || '';

function usage() {
  process.stderr.write(`Usage:
  agentctl.js capabilities
  agentctl.js status
  agentctl.js settings
  agentctl.js settings-patch '<json object>'
  agentctl.js audit [limit]
  agentctl.js task <maintain_sources|sync_source_lists|check_vod_providers|refresh_live_catalog>
  agentctl.js live-sources
  agentctl.js vod-sources
  agentctl.js vod-search <all|movies|series|anime> [search terms...]
  agentctl.js archive-search [search terms...]
  agentctl.js commons-search [search terms...]
  agentctl.js import-list <registry-json-url>
  agentctl.js add-vod <name> <api-url> [all|movies|series|anime]
  agentctl.js enable-vod <id>
  agentctl.js disable-vod <id>
  agentctl.js delete-vod <id>
  agentctl.js add-live <name> <m3u-url>
  agentctl.js enable-live <id>
  agentctl.js disable-live <id>
  agentctl.js delete-live <id>

Environment:
  IPTV_BASE_URL=https://your-private-deployment
  AGENT_API_TOKEN=<secret; header only>
`);
}
function baseUrl() {
  let url;
  try { url = new URL(DEFAULT_BASE); } catch { throw new Error('IPTV_BASE_URL must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('IPTV_BASE_URL must use HTTP(S) and must not embed credentials');
  return url.toString().replace(/\/$/, '');
}
async function request(path, method = 'GET', body = undefined) {
  if (!TOKEN) throw new Error('AGENT_API_TOKEN is required; set it in the Hermes process environment, not in shell history.');
  const headers = { 'X-Agent-Token': TOKEN, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(baseUrl() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw new Error('Could not connect to IPTV Web agent API: ' + String(err.message || err));
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error || payload.hint || ('HTTP ' + response.status);
    throw new Error(detail);
  }
  return payload;
}
function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
async function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === 'help') return usage();
  if (command === 'capabilities') return print(await request('/api/agent/v1/capabilities'));
  if (command === 'status') return print(await request('/api/agent/v1/status'));
  if (command === 'settings') return print(await request('/api/agent/v1/settings'));
  if (command === 'settings-patch') {
    let patch;
    try { patch = JSON.parse(args.join(' ')); } catch { throw new Error('settings-patch expects a valid JSON object'); }
    return print(await request('/api/agent/v1/settings', 'PATCH', patch));
  }
  if (command === 'audit') return print(await request('/api/agent/v1/audit?limit=' + encodeURIComponent(args[0] || '50')));
  if (command === 'task') {
    if (!args[0]) throw new Error('task requires a task name');
    return print(await request('/api/agent/v1/tasks/run', 'POST', { task: args[0] }));
  }
  if (command === 'live-sources') return print(await request('/api/agent/v1/live/sources'));
  if (command === 'vod-sources') return print(await request('/api/agent/v1/vod/sources'));
  if (command === 'vod-search') {
    const type = args.shift();
    if (!['all', 'movies', 'series', 'anime'].includes(type)) throw new Error('vod-search type must be all, movies, series, or anime');
    return print(await request('/api/agent/v1/vod/search?type=' + encodeURIComponent(type) + '&q=' + encodeURIComponent(args.join(' '))));
  }
  if (command === 'archive-search') return print(await request('/api/agent/v1/archive/search?type=all&q=' + encodeURIComponent(args.join(' '))));
  if (command === 'commons-search') return print(await request('/api/agent/v1/commons/search?type=all&q=' + encodeURIComponent(args.join(' '))));
  if (command === 'import-list') {
    if (!args[0]) throw new Error('import-list requires a registry JSON URL');
    return print(await request('/api/agent/v1/vod/import', 'POST', { url: args[0] }));
  }
  if (command === 'add-vod') {
    if (args.length < 2) throw new Error('add-vod requires a name and API URL');
    const [name, api, kind = 'all'] = args;
    if (!['all', 'movies', 'series', 'anime'].includes(kind)) throw new Error('invalid VOD kind');
    return print(await request('/api/agent/v1/vod/sources', 'POST', { name, api, kind }));
  }
  if (['enable-vod', 'disable-vod', 'delete-vod'].includes(command)) {
    const id = args[0];
    if (!id) throw new Error(command + ' requires a provider ID');
    if (command === 'delete-vod') return print(await request('/api/agent/v1/vod/sources/' + encodeURIComponent(id), 'DELETE'));
    return print(await request('/api/agent/v1/vod/sources/' + encodeURIComponent(id), 'PATCH', { enabled: command === 'enable-vod' }));
  }
  if (command === 'add-live') {
    if (args.length < 2) throw new Error('add-live requires a name and M3U/M3U8 URL');
    return print(await request('/api/agent/v1/live/sources', 'POST', { name: args[0], url: args[1] }));
  }
  if (['enable-live', 'disable-live', 'delete-live'].includes(command)) {
    const id = args[0];
    if (!id) throw new Error(command + ' requires a source ID');
    if (command === 'delete-live') return print(await request('/api/agent/v1/live/sources/' + encodeURIComponent(id), 'DELETE'));
    return print(await request('/api/agent/v1/live/sources/' + encodeURIComponent(id), 'PATCH', { enabled: command === 'enable-live' }));
  }
  usage();
  throw new Error('unknown command: ' + command);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write('agentctl: ' + String(err.message || err) + '\n');
  process.exitCode = 1;
});
