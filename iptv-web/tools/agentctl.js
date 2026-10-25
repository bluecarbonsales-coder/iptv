#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
// Dependency-free CLI for Hermes and other trusted agents. It uses only the documented agent API.
const DEFAULT_BASE = process.env.IPTV_BASE_URL || 'http://127.0.0.1:3920';
const ADMIN_USERNAME = process.env.IPTV_ADMIN_USERNAME || process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.IPTV_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '0809';

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
  agentctl.js project-status
  agentctl.js project-tree [path] [ref]
  agentctl.js project-file <path> [ref]
  agentctl.js project-commit <changes.json> (writes directly to target branch by default)
  agentctl.js project-branch <name> [base]
  agentctl.js project-pr <head> <base> <title> [body]
  agentctl.js project-merge <number> [merge|squash|rebase] [commit title]
  agentctl.js project-dispatch <workflow-file> [ref] [inputs-json]
  agentctl.js project-actions [branch] [limit]
  agentctl.js project-checks <commit-sha>
  agentctl.js project-commit can set {\"createPullRequest\":true} to open a PR instead of writing to its target branch

A project commit JSON file can contain:
  {"message":"Fix issue","baseBranch":"main","createPullRequest":true,
   "pullRequestTitle":"Fix issue","changes":[{"path":"file.js","content":"..."}]}

Environment:
  IPTV_BASE_URL=https://your-private-deployment
  IPTV_ADMIN_USERNAME=admin (same login as /admin.html)\n  IPTV_ADMIN_PASSWORD=<admin password>
`);
}
function baseUrl() {
  let url;
  try { url = new URL(DEFAULT_BASE); } catch { throw new Error('IPTV_BASE_URL must be a valid absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('IPTV_BASE_URL must use HTTP(S) and must not embed credentials');
  return url.toString().replace(/\/$/, '');
}
async function request(path, method = 'GET', body = undefined) {
  const headers = { Authorization: 'Basic ' + Buffer.from(ADMIN_USERNAME + ':' + ADMIN_PASSWORD).toString('base64'), Accept: 'application/json' };
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
  if (command === 'project-status') return print(await request('/api/agent/v1/project/status'));
  if (command === 'project-tree') {
    const prefix = args[0] || '';
    const ref = args[1] || 'main';
    return print(await request('/api/agent/v1/project/tree?path=' + encodeURIComponent(prefix) + '&ref=' + encodeURIComponent(ref) + '&recursive=true'));
  }
  if (command === 'project-file') {
    if (!args[0]) throw new Error('project-file requires a repository path');
    const ref = args[1] || 'main';
    return print(await request('/api/agent/v1/project/file?path=' + encodeURIComponent(args[0]) + '&ref=' + encodeURIComponent(ref)));
  }
  if (command === 'project-commit') {
    if (!args[0]) throw new Error('project-commit requires a JSON file containing message and changes');
    const filePath = path.resolve(args[0]);
    let payload;
    try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (err) { throw new Error('Could not read project change JSON: ' + err.message); }
    return print(await request('/api/agent/v1/project/commit', 'POST', payload));
  }
  if (command === 'project-branch') {
    if (!args[0]) throw new Error('project-branch requires a branch name');
    return print(await request('/api/agent/v1/project/branch', 'POST', { name: args[0], base: args[1] || 'main' }));
  }
  if (command === 'project-pr') {
    if (args.length < 3) throw new Error('project-pr requires head branch, base branch, and title');
    return print(await request('/api/agent/v1/project/pr', 'POST', { head: args[0], base: args[1], title: args[2], body: args.slice(3).join(' ') }));
  }
  if (command === 'project-merge') {
    if (!args[0]) throw new Error('project-merge requires a pull-request number');
    return print(await request('/api/agent/v1/project/pr/' + encodeURIComponent(args[0]) + '/merge', 'POST', { method: args[1] || 'squash', commitTitle: args.slice(2).join(' ') }));
  }
  if (command === 'project-dispatch') {
    if (!args[0]) throw new Error('project-dispatch requires a workflow filename');
    let inputs = {};
    if (args[2]) {
      try { inputs = JSON.parse(args[2]); } catch { throw new Error('workflow inputs must be valid JSON'); }
    }
    return print(await request('/api/agent/v1/project/dispatch', 'POST', { workflow: args[0], ref: args[1] || 'main', inputs }));
  }
  if (command === 'project-actions') {
    const branch = args[0] || 'main';
    const limit = args[1] || '10';
    return print(await request('/api/agent/v1/project/actions?branch=' + encodeURIComponent(branch) + '&limit=' + encodeURIComponent(limit)));
  }
  if (command === 'project-checks') {
    if (!args[0]) throw new Error('project-checks requires a commit SHA');
    return print(await request('/api/agent/v1/project/checks/' + encodeURIComponent(args[0])));
  }
  usage();
  throw new Error('unknown command: ' + command);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write('agentctl: ' + String(err.message || err) + '\n');
  process.exitCode = 1;
});
