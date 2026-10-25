'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../lib/router');

test('registers PUT routes with path parameters', () => {
  const router = new Router();
  const handler = () => {};
  router.put('/api/agent/v1/navigation', handler);
  const match = router.match('PUT', '/api/agent/v1/navigation');
  assert.ok(match);
  assert.equal(match.handler, handler);
  assert.deepEqual(match.params, {});
});

test('PUT routes do not match other HTTP methods', () => {
  const router = new Router();
  const handler = () => {};
  router.put('/api/agent/v1/navigation', handler);
  assert.equal(router.match('GET', '/api/agent/v1/navigation'), null);
  assert.equal(router.match('POST', '/api/agent/v1/navigation'), null);
});

test('PUT routes support named path parameters', () => {
  const router = new Router();
  const handler = () => {};
  router.put('/api/items/:id', handler);
  const match = router.match('PUT', '/api/items/abc-123');
  assert.ok(match);
  assert.deepEqual(match.params, { id: 'abc-123' });
});
