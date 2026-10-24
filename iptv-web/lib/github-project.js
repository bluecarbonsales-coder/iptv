'use strict';
// GitHub-backed, full-repository control for authenticated project agents.
// The GitHub credential stays on the server; API callers never receive it.
const API = 'https://api.github.com';
const TOKEN_NAMES = ['GITHUB_REPO_TOKEN', 'GITHUB_TOKEN'];
const MAX_CHANGE_BYTES = 20 * 1024 * 1024;
const MAX_TREE_RESULTS = 100000;

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw Object.assign(new Error('GITHUB_REPOSITORY must use owner/repository form'), { statusCode: 500 });
  }
  return repo;
}
function validateBranch(value) {
  const branch = String(value || '').trim();
  if (!branch || branch.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      branch.includes('..') || branch.includes('//') || branch.endsWith('/') ||
      branch.endsWith('.') || branch.endsWith('.lock') || branch.includes('@{')) {
    throw Object.assign(new Error('Invalid Git branch name'), { statusCode: 400 });
  }
  return branch;
}
function validatePath(value) {
  const path = String(value || '').trim();
  if (!path || path.length > 1024 || path.startsWith('/') || path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      path.includes('\0')) {
    throw Object.assign(new Error('Invalid repository path'), { statusCode: 400 });
  }
  return path;
}
function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}
function responsePayload(message, statusCode) {
  let detail = message;
  try {
    const parsed = JSON.parse(message);
    detail = parsed.message || parsed.error || message;
    if (parsed.errors && Array.isArray(parsed.errors)) {
      detail += ': ' + parsed.errors.map((item) => item.message || item.code || '').filter(Boolean).join('; ');
    }
  } catch {}
  return Object.assign(new Error(String(detail).slice(0, 1500)), { statusCode });
}
function createGitHubProject(options = {}) {
  const repo = validateRepo(options.repository || process.env.GITHUB_REPOSITORY || 'bluecarbonsales-coder/iptv');
  const defaultBranch = validateBranch(options.defaultBranch || process.env.GITHUB_DEFAULT_BRANCH || 'main');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  function token() {
    for (const name of TOKEN_NAMES) {
      if (options.token || process.env[name]) return options.token || process.env[name];
    }
    throw Object.assign(new Error('GitHub project API is not configured. Set GITHUB_REPO_TOKEN with repository contents, pull-request, and Actions write permissions.'), { statusCode: 503 });
  }
  function url(path) {
    return API + '/repos/' + repo + path;
  }
  async function request(method, path, body) {
    const secret = token();
    let response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + secret,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'IPTV-Web-Agent-Control',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw Object.assign(new Error('GitHub API request failed: ' + String(err.message || err)), { statusCode: 502 });
    }
    const raw = await response.text();
    let result = null;
    if (raw) {
      try { result = JSON.parse(raw); }
      catch { throw Object.assign(new Error('GitHub API returned invalid JSON'), { statusCode: 502 }); }
    }
    if (!response.ok) throw responsePayload(raw || ('GitHub HTTP ' + response.status), response.status);
    return result;
  }
  async function getRef(branch) {
    const name = validateBranch(branch);
    const result = await request('GET', '/git/ref/heads/' + encodeURIComponent(name));
    return { branch: name, sha: result.object.sha, ref: result.ref };
  }
  async function getRefOrCreate(branch, baseBranch) {
    try { return await getRef(branch); }
    catch (err) {
      if (err.statusCode !== 404 || branch === baseBranch) throw err;
      const base = await getRef(baseBranch);
      try {
        await request('POST', '/git/refs', { ref: 'refs/heads/' + branch, sha: base.sha });
      } catch (createErr) {
        if (createErr.statusCode !== 422 && createErr.statusCode !== 409) throw createErr;
      }
      return getRef(branch);
    }
  }
  async function status() {
    const result = await request('GET', '');
    const [ref, workflows] = await Promise.all([
      getRef(result.default_branch || defaultBranch),
      request('GET', '/actions/workflows?per_page=100'),
    ]);
    return {
      repository: result.full_name,
      private: result.private,
      defaultBranch: result.default_branch || defaultBranch,
      permissions: result.permissions || null,
      head: ref.sha,
      htmlUrl: result.html_url,
      visibility: result.visibility || (result.private ? 'private' : 'public'),
      workflows: (workflows.workflows || []).map((workflow) => ({
        id: workflow.id, name: workflow.name, path: workflow.path, state: workflow.state,
        url: workflow.html_url, dispatchable: workflow.state === 'active',
      })),
    };
  }
  async function tree({ path: prefix = '', ref = defaultBranch, recursive = true, limit = 10000 } = {}) {
    const branch = validateBranch(ref);
    const tip = await getRef(branch);
    const commit = await request('GET', '/git/commits/' + tip.sha);
    const params = recursive ? '?recursive=1' : '';
    const result = await request('GET', '/git/trees/' + commit.tree.sha + params);
    const normalizedPrefix = prefix ? validatePath(prefix).replace(/\/$/, '') : '';
    let entries = (result.tree || []).filter((entry) => {
      if (normalizedPrefix && entry.path !== normalizedPrefix && !entry.path.startsWith(normalizedPrefix + '/')) return false;
      return true;
    });
    const max = Math.max(1, Math.min(MAX_TREE_RESULTS, Number(limit) || 10000));
    const total = entries.length;
    entries = entries.slice(0, max).map((entry) => ({
      path: entry.path, type: entry.type, mode: entry.mode, sha: entry.sha,
      size: entry.size ?? null, url: entry.url || null,
    }));
    return { repository: repo, ref: branch, commit: tip.sha, tree: entries, total, truncated: !!result.truncated || total > entries.length };
  }
  async function file({ path: pathValue, ref = defaultBranch, base64 = false } = {}) {
    const path = validatePath(pathValue);
    const branch = validateBranch(ref);
    const result = await request('GET', '/contents/' + encodePath(path) + '?ref=' + encodeURIComponent(branch));
    if (Array.isArray(result) || result.type !== 'file') {
      throw Object.assign(new Error('Path is not a file. Use the tree endpoint to inspect directory contents.'), { statusCode: 400 });
    }
    let encoding = result.encoding;
    let content = result.content || '';
    if (encoding === 'base64') {
      content = Buffer.from(content.replace(/\s+/g, ''), 'base64').toString(base64 ? 'base64' : 'utf8');
    } else if (encoding === 'none' && result.git_url) {
      const blob = await request('GET', '/git/blobs/' + result.sha);
      if (blob.encoding !== 'base64') throw Object.assign(new Error('Unsupported blob encoding'), { statusCode: 502 });
      content = Buffer.from(String(blob.content || '').replace(/\s+/g, ''), 'base64').toString(base64 ? 'base64' : 'utf8');
      encoding = 'base64';
    }
    return {
      repository: repo, path, ref: branch, sha: result.sha,
      size: result.size || Buffer.byteLength(String(content)),
      encoding: base64 ? 'base64' : 'utf8',
      content,
      htmlUrl: result.html_url,
    };
  }
  async function commitChanges(input = {}) {
    const message = String(input.message || '').trim().slice(0, 500);
    if (!message) throw Object.assign(new Error('Commit message is required'), { statusCode: 400 });
    if (!Array.isArray(input.changes) || !input.changes.length) throw Object.assign(new Error('changes must be a non-empty array'), { statusCode: 400 });
    const changes = new Map();
    let totalBytes = 0;
    for (const raw of input.changes) {
      const path = validatePath(raw && raw.path);
      const action = raw && (raw.action || 'upsert');
      if (!['upsert', 'delete'].includes(action)) throw Object.assign(new Error('action must be upsert or delete'), { statusCode: 400 });
      if (action === 'upsert' && typeof raw.content !== 'string') throw Object.assign(new Error('content must be a string for ' + path), { statusCode: 400 });
      const content = action === 'upsert' ? raw.content : undefined;
      if (content !== undefined) totalBytes += Buffer.byteLength(content, 'utf8');
      if (totalBytes > MAX_CHANGE_BYTES) throw Object.assign(new Error('A single repository commit is limited to 20 MiB of file content'), { statusCode: 413 });
      const mode = raw.mode || '100644';
      if (!['100644', '100755', '120000'].includes(mode)) throw Object.assign(new Error('mode must be 100644, 100755, or 120000'), { statusCode: 400 });
      changes.set(path, { path, action, content, mode });
    }
    const baseBranch = validateBranch(input.baseBranch || defaultBranch);
    const targetBranch = validateBranch(input.branch || baseBranch);
    const target = await getRefOrCreate(targetBranch, baseBranch);
    const parent = await request('GET', '/git/commits/' + target.sha);
    const entries = [...changes.values()].map((change) => change.action === 'delete'
      ? { path: change.path, mode: change.mode, type: 'blob', sha: null }
      : { path: change.path, mode: change.mode, type: 'blob', content: change.content });
    const newTree = await request('POST', '/git/trees', { base_tree: parent.tree.sha, tree: entries });
    const commit = await request('POST', '/git/commits', {
      message,
      tree: newTree.sha,
      parents: [target.sha],
    });
    const updated = await request('PATCH', '/git/refs/heads/' + encodeURIComponent(targetBranch), { sha: commit.sha, force: false });
    return {
      repository: repo,
      branch: targetBranch,
      baseBranch,
      commit: commit.sha,
      parent: target.sha,
      message,
      changedFiles: [...changes.values()].map(({ path, action }) => ({ path, action })),
      commitUrl: commit.html_url || 'https://github.com/' + repo + '/commit/' + commit.sha,
      branchUrl: 'https://github.com/' + repo + '/tree/' + encodeURIComponent(targetBranch),
      updatedRef: updated.ref,
    };
  }
  async function createBranch({ name, base = defaultBranch } = {}) {
    const branch = validateBranch(name);
    const baseBranch = validateBranch(base);
    const baseRef = await getRef(baseBranch);
    try {
      const created = await request('POST', '/git/refs', { ref: 'refs/heads/' + branch, sha: baseRef.sha });
      return { repository: repo, branch, base: baseBranch, sha: created.object.sha, created: true };
    } catch (err) {
      if (err.statusCode !== 422 && err.statusCode !== 409) throw err;
      const existing = await getRef(branch);
      return { repository: repo, branch, base: baseBranch, sha: existing.sha, created: false };
    }
  }
  async function pullRequest({ head, base = defaultBranch, title, body = '', draft = false } = {}) {
    const branch = validateBranch(head);
    const baseBranch = validateBranch(base);
    if (branch === baseBranch) throw Object.assign(new Error('head and base branches must differ to create a PR'), { statusCode: 400 });
    const result = await request('POST', '/pulls', {
      head: branch, base: baseBranch, title: String(title || 'Agent update').slice(0, 240),
      body: String(body || '').slice(0, 60000), draft: !!draft,
    });
    return { number: result.number, state: result.state, url: result.html_url, title: result.title, head: branch, base: baseBranch };
  }
  async function mergePullRequest({ number, method = 'squash', commitTitle = '', commitMessage = '' } = {}) {
    const id = Number(number);
    if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Invalid pull-request number'), { statusCode: 400 });
    if (!['merge', 'squash', 'rebase'].includes(method)) throw Object.assign(new Error('method must be merge, squash, or rebase'), { statusCode: 400 });
    const result = await request('PUT', '/pulls/' + id + '/merge', {
      merge_method: method,
      ...(commitTitle ? { commit_title: String(commitTitle).slice(0, 240) } : {}),
      ...(commitMessage ? { commit_message: String(commitMessage).slice(0, 60000) } : {}),
    });
    return { number: id, merged: result.merged, sha: result.sha, message: result.message, url: 'https://github.com/' + repo + '/pull/' + id };
  }
  async function dispatchWorkflow({ workflow, ref = defaultBranch, inputs = {} } = {}) {
    const file = String(workflow || '').trim();
    if (!file || file.includes('..') || file.includes('/') || file.length > 160) {
      throw Object.assign(new Error('workflow must be an existing workflow filename or numeric ID'), { statusCode: 400 });
    }
    const branch = validateBranch(ref);
    const result = await request('POST', '/actions/workflows/' + encodeURIComponent(file) + '/dispatches', { ref: branch, inputs });
    return { repository: repo, workflow: file, ref: branch, dispatched: true, result: result || null };
  }
  async function actions({ branch = defaultBranch, limit = 10 } = {}) {
    const params = new URLSearchParams({ branch: validateBranch(branch), per_page: String(Math.max(1, Math.min(50, Number(limit) || 10))) });
    const result = await request('GET', '/actions/runs?' + params.toString());
    return {
      total: result.total_count || 0,
      runs: (result.workflow_runs || []).map((run) => ({
        id: run.id, name: run.name, event: run.event, status: run.status, conclusion: run.conclusion,
        branch: run.head_branch, sha: run.head_sha, url: run.html_url, createdAt: run.created_at, updatedAt: run.updated_at,
      })),
    };
  }
  async function commitStatus(sha) {
    const id = String(sha || '').trim();
    if (!/^[a-f0-9]{7,64}$/i.test(id)) throw Object.assign(new Error('Invalid commit SHA'), { statusCode: 400 });
    const [status, checks] = await Promise.all([
      request('GET', '/commits/' + id + '/status'),
      request('GET', '/commits/' + id + '/check-runs'),
    ]);
    return {
      sha: id,
      state: status.state,
      totalCount: status.total_count,
      statuses: (status.statuses || []).map((item) => ({ context: item.context, state: item.state, description: item.description, targetUrl: item.target_url })),
      checks: (checks.check_runs || []).map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion, url: item.html_url })),
    };
  }
  return {
    repository: repo, defaultBranch,
    configured: () => TOKEN_NAMES.some((name) => !!(options.token || process.env[name])),
    status, tree, file, commitChanges, createBranch, pullRequest, mergePullRequest, dispatchWorkflow, actions, commitStatus,
  };
}
module.exports = { createGitHubProject, validateRepo, validateBranch, validatePath, encodePath, MAX_CHANGE_BYTES };
