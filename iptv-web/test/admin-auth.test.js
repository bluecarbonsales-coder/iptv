'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesAdminCredentials } = require('../lib/admin-auth');
test('admin API auth accepts Basic credentials and rejects token schemes', () => {
  const oldUser = process.env.ADMIN_USERNAME, oldPass = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'test-admin'; process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  const req = authorization => ({ headers: authorization ? { authorization } : {} });
  try {
    const valid = 'Basic ' + Buffer.from('test-admin:correct horse battery staple').toString('base64');
    assert.equal(matchesAdminCredentials(req(valid)), true);
    assert.equal(matchesAdminCredentials(req('Bearer correct horse battery staple')), false);
    assert.equal(matchesAdminCredentials(req('Basic ' + Buffer.from('test-admin:wrong').toString('base64'))), false);
    assert.equal(matchesAdminCredentials(req()), false);
  } finally {
    if (oldUser === undefined) delete process.env.ADMIN_USERNAME; else process.env.ADMIN_USERNAME = oldUser;
    if (oldPass === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = oldPass;
  }
});
