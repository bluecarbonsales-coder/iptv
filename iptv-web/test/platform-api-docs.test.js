'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ROUTES, describeApi, buildOpenApi } = require('../lib/platform-api-docs');

test('the platform has one common API base and a machine-readable OpenAPI document', () => {
  const index = describeApi();
  assert.equal(index.basePath, '/api/v1');
  assert.equal(index.openapi, '/api/v1/openapi.json');
  assert.ok(index.groups.length >= 8);
  const spec = buildOpenApi();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, '/api/v1');
  assert.ok(spec.components.securitySchemes.AdminLogin);
  assert.ok(spec.components.securitySchemes.AgentToken);
  assert.ok(spec.paths['/sources']);
});

test('the common API documents source CRUD for radio, IPTV and Theatre', () => {
  const rows = new Set(ROUTES.map(([method, path]) => method + ' ' + path));
  assert.ok(rows.has('GET /sources'));
  assert.ok(rows.has('GET /sources/{type}'));
  assert.ok(rows.has('POST /sources/{type}'));
  assert.ok(rows.has('POST /sources/{type}/enable-all'));
  assert.ok(rows.has('PATCH /sources/{type}/{id}'));
  assert.ok(rows.has('DELETE /sources/{type}/{id}'));
  for (const type of ['radio', 'iptv', 'theatre']) {
    assert.ok(rows.has('POST /sources/{type}'), 'common POST route supports ' + type);
  }
  const spec = buildOpenApi();
  assert.ok(spec.paths['/sources/{type}'].get.security);
  assert.ok(spec.paths['/sources/{type}'].post.security);
  assert.ok(spec.paths['/sources/{type}/{id}'].patch.security);
  assert.ok(spec.paths['/sources/{type}/{id}'].delete.security);
});

test('the common API lists the main platform areas and advanced agents separately', () => {
  const groups = new Set(describeApi().groups.map((group) => group.name));
  for (const name of ['General', 'Sources', 'IPTV', 'Radio', 'Theatre', 'Portal', 'Metadata', 'Mail', 'Agent', 'Visitor']) {
    assert.ok(groups.has(name), 'missing API group ' + name);
  }
  const spec = buildOpenApi();
  assert.ok(spec.paths['/iptv/channels'].get);
  assert.ok(spec.paths['/radio/stations'].get);
  assert.ok(spec.paths['/theatre/titles'].get);
  assert.ok(spec.paths['/mail/login'].post);
  assert.ok(spec.paths['/agent/status'].get.security);
});
