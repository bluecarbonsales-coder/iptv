'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('example environment file contains placeholders, not deploy credentials', () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  for (const name of [
    'ADMIN_PASSWORD',
    'GITHUB_REPO_TOKEN',
    'TMDB_API_KEY',
    'OMDB_API_KEY',
    'EMAIL_WORKSPACE_PASSWORD',
    'EMAIL_SESSION_SECRET',
    'EMAIL_CREDENTIALS_KEY',
    'JACKETT_API_KEY',
  ]) {
    const line = env.split('\n').find(value => value.startsWith(name + '='));
    assert.ok(line, name + ' should be documented');
    assert.equal(line, name + '=', name + ' must not contain a committed credential value');
  }
  assert.match(env, /^JACKETT_URL=$/m);
});
