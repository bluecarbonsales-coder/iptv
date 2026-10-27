'use strict';

// Regression tests for the "a fix never reaches the browser" class of bug: public/*.js was
// served with `Cache-Control: public, max-age=86400`, so the repaired player kept running the
// broken app.js for a day after the deploy (and, more subtly, a cached page kept pointing at
// the old asset URL). Pages/scripts/styles revalidate now, and the HTML served carries
// ?v=<asset mtime> so an already-cached URL is bypassed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { serveStatic } = require('../lib/static');

function mockRes() {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.status = null;
  res.headers = null;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; };
  res.text = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

async function request(handler, url, headers = {}) {
  const res = mockRes();
  const handled = await handler({ method: 'GET', url, headers }, res);
  if (res.status !== null) await finished(res);
  return { handled, status: res.status, headers: res.headers || {}, body: res.text() };
}

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-static-'));
  fs.writeFileSync(path.join(dir, 'page.html'), [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/app.css">',
    '</head><body>',
    '<script src="/app.js"></script>',
    '<script src="/missing.js"></script>',
    '<script src="https://cdn.example/x.js"></script>',
    '</body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("player");\n');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body{margin:0}\n');
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

test('pages and code revalidate while images keep the long cache', async () => {
  const dir = fixtureDir();
  try {
    const handler = serveStatic(dir);
    const page = await request(handler, '/page.html');
    assert.equal(page.status, 200);
    assert.equal(page.headers['Cache-Control'], 'no-cache');
    assert.equal((await request(handler, '/app.js')).headers['Cache-Control'], 'no-cache');
    assert.equal((await request(handler, '/app.css')).headers['Cache-Control'], 'no-cache');
    assert.equal((await request(handler, '/logo.png')).headers['Cache-Control'], 'public, max-age=86400');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('served HTML stamps root-absolute assets with their mtime and leaves the rest alone', async () => {
  const dir = fixtureDir();
  try {
    const handler = serveStatic(dir);
    const { body } = await request(handler, '/page.html');
    const jsStamp = Math.round(fs.statSync(path.join(dir, 'app.js')).mtimeMs);
    const cssStamp = Math.round(fs.statSync(path.join(dir, 'app.css')).mtimeMs);
    assert.ok(body.includes(`<script src="/app.js?v=${jsStamp}"></script>`), body);
    assert.ok(body.includes(`<link rel="stylesheet" href="/app.css?v=${cssStamp}">`), body);
    // A reference to a file that does not exist, and an external URL, must stay untouched —
    // stamping them would break app routes and third-party scripts.
    assert.ok(body.includes('<script src="/missing.js"></script>'), body);
    assert.ok(body.includes('<script src="https://cdn.example/x.js"></script>'), body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a matching ETag still answers 304, and a stale one gets the stamped page', async () => {
  const dir = fixtureDir();
  try {
    const handler = serveStatic(dir);
    const first = await request(handler, '/page.html');
    const fresh = await request(handler, '/page.html', { 'if-none-match': first.headers.ETag });
    assert.equal(fresh.status, 304);
    const stale = await request(handler, '/page.html', { 'if-none-match': 'W/"nonsense"' });
    assert.equal(stale.status, 200);
    assert.ok(stale.body.includes('/app.js?v='), stale.body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
