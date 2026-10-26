'use strict';

// A single failing upstream request must never take the portal down.
//
// Real incident (2026-10-27): a 404 from a stream origin crashed the process. `hls.handler()`
// read the body with bodyToString(), then called `response.body.cancel()` on that now-locked
// stream — which REJECTS with ERR_INVALID_STATE per the Web Streams spec — and Node terminates
// the process on an unhandled rejection. Docker restarted the container, dropping every viewer
// and forcing a full catalogue reload.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../lib/router');
const hls = require('../lib/hls');
const { cancelBody } = require('../lib/fetch-upstream');

function recorder() {
  return {
    status: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = body == null ? '' : String(body); this.writableEnded = true; },
  };
}

// Collect unhandled rejections for the duration of a callback. Node's default behaviour for
// these is process death, so the assertion is "nothing must be reported".
async function withRejectionSpy(fn) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve)); // let orphans surface
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

test('an upstream 404 on /hls is answered instead of killing the process', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } });
  try {
    const res = recorder();
    // An IP literal keeps assertSafeUrl() (which does a real DNS lookup) out of the test.
    const seen = await withRejectionSpy(() => hls.handler({ method: 'GET', headers: {} }, res, {}, { u: 'https://1.1.1.1/live/playlist.m3u8' }));
    assert.equal(res.status, 404, 'the upstream status is passed through');
    assert.match(res.body, /upstream responded 404/);
    assert.deepEqual(seen, [], 'no unhandled rejection may escape the relay');
  } finally {
    globalThis.fetch = original;
  }
});

test('cancelling an already-read body leaks no rejection', async () => {
  const response = new Response('payload', { status: 200 });
  await response.arrayBuffer(); // consumes (and locks) the body, exactly like bodyToString()
  const seen = await withRejectionSpy(() => cancelBody(response));
  assert.deepEqual(seen, []);
});

test('a throwing route handler becomes a 500, not an unhandled rejection', async () => {
  const router = new Router();
  router.get('/boom', async () => { throw new Error('handler exploded'); });
  const res = recorder();
  const seen = await withRejectionSpy(() => router.handle({ method: 'GET', url: '/boom', headers: {} }, res));
  assert.equal(res.status, 500);
  assert.match(res.body, /internal error/);
  assert.deepEqual(seen, []);
});
