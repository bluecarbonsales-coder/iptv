'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGitHubProject,
  validateBranch,
  validatePath,
  validateRepo,
} = require('../lib/github-project');

test('repository and branch validation accepts full project branches without limiting file scope', () => {
  assert.equal(validateRepo('owner/repo'), 'owner/repo');
  assert.equal(validateBranch('main'), 'main');
  assert.equal(validateBranch('agent/full-project-edit'), 'agent/full-project-edit');
  assert.equal(validatePath('.github/workflows/deploy.yml'), '.github/workflows/deploy.yml');
  assert.equal(validatePath('iptv-web/server.js'), 'iptv-web/server.js');
  assert.throws(() => validateRepo('https://github.com/owner/repo'), /owner\/repository/);
  assert.throws(() => validateBranch('../main'), /branch name/);
  assert.throws(() => validatePath('../secrets.txt'), /repository path/);
  assert.throws(() => validatePath('/absolute/path'), /repository path/);
});

test('multi-file commit can update app code and workflow files plus delete files', async () => {
  const requests = [];
  const responses = [
    { status: 200, body: { ref: 'refs/heads/main', object: { sha: 'oldcommit' } } },
    { status: 200, body: { sha: 'oldcommit', tree: { sha: 'oldtree' } } },
    { status: 201, body: { sha: 'newtree' } },
    { status: 201, body: { sha: 'newcommit', html_url: 'https://github.com/owner/repo/commit/newcommit' } },
    { status: 200, body: { ref: 'refs/heads/main', object: { sha: 'newcommit' } } },
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift();
    assert.ok(next, 'unexpected GitHub request');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const github = createGitHubProject({
    token: 'github-secret',
    repository: 'owner/repo',
    defaultBranch: 'main',
    fetchImpl,
  });
  const result = await github.commitChanges({
    message: 'Agent updates the project',
    changes: [
      { path: 'iptv-web/server.js', content: '/* updated by trusted agent */\n' },
      { path: '.github/workflows/deploy.yml', content: 'name: deploy\n', mode: '100644' },
      { path: 'iptv-web/old-file.js', action: 'delete' },
    ],
  });
  assert.equal(result.commit, 'newcommit');
  assert.equal(result.branch, 'main');
  assert.equal(result.changedFiles.length, 3);
  const treeRequest = requests.find((request) => request.url.endsWith('/git/trees'));
  assert.equal(treeRequest.body.base_tree, 'oldtree');
  assert.deepEqual(treeRequest.body.tree.map((entry) => entry.path), [
    'iptv-web/server.js',
    '.github/workflows/deploy.yml',
    'iptv-web/old-file.js',
  ]);
  assert.equal(treeRequest.body.tree[2].sha, null);
  assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer github-secret'));
  assert.equal(JSON.stringify(result).includes('github-secret'), false);
});

test('repository API remains unconfigured without a server-side GitHub token', async () => {
  const github = createGitHubProject({
    repository: 'owner/repo',
    defaultBranch: 'main',
    fetchImpl: async () => { throw new Error('should not send a request'); },
  });
  assert.equal(github.configured(), false);
  await assert.rejects(github.status(), { statusCode: 503 });
});

test('full project control supports merge and workflow dispatch using authenticated GitHub API calls', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes('/pulls/7/merge')) {
      return new Response(JSON.stringify({ merged: true, sha: 'merge-sha', message: 'merged' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  };
  const github = createGitHubProject({ token: 'secret', repository: 'owner/repo', fetchImpl });
  assert.equal((await github.mergePullRequest({ number: 7, method: 'squash' })).merged, true);
  assert.equal((await github.dispatchWorkflow({ workflow: 'ci.yml', ref: 'agent/full-project-edit', inputs: { task: 'test' } })).dispatched, true);
  assert.equal(requests[0].method, 'PUT');
  assert.equal(requests[0].body.merge_method, 'squash');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].body.ref, 'agent/full-project-edit');
});
