'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRadioApi, normalizeStation, safeHttpUrl, UUID_RE } = require('../lib/radio');

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body == null ? '' : String(body); },
    on() { return this; },
  };
}
function request(url) {
  return { url, headers: {}, socket: { remoteAddress: '127.0.0.1' }, on() {} };
}

test('radio station normalization uses stable UUIDs and bounded public metadata', () => {
  assert.equal(UUID_RE.test('01234567-89ab-cdef-0123-456789abcdef'), true);
  assert.equal(normalizeStation({ stationuuid: 'bad', name: 'x' }), null);
  const station = normalizeStation({
    stationuuid: '01234567-89ab-cdef-0123-456789abcdef',
    name: '  Jazz Radio\n',
    countrycode: 'us',
    language: 'english,french',
    tags: 'jazz,pop',
    bitrate: '256',
    hls: 1,
    favicon: 'https://example.com/icon.png',
  });
  assert.equal(station.name, 'Jazz Radio');
  assert.equal(station.countrycode, 'US');
  assert.equal(station.bitrate, 256);
  assert.equal(station.hls, true);
  assert.equal(station.tags, 'jazz,pop');
});

test('radio URL validation accepts public HTTP(S) streams and rejects unsafe schemes/credentials', () => {
  assert.equal(safeHttpUrl('https://radio.example/live.mp3').protocol, 'https:');
  assert.equal(safeHttpUrl('http://radio.example:8080/stream').protocol, 'http:');
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@radio.example', '']) {
    assert.equal(safeHttpUrl(url), null);
  }
});

test('station search clamps paging and ignores unsupported sorting values', async () => {
  let calledUrl = '';
  const api = createRadioApi({
    mirrors: ['https://de1.api.radio-browser.info'],
    minRequestIntervalMs: 0,
    upstreamFetch: async (url) => {
      calledUrl = url;
      return { response: new Response(JSON.stringify([{
        stationuuid: '01234567-89ab-cdef-0123-456789abcdef',
        name: 'Radio Jazz',
        countrycode: 'US',
        bitrate: 128,
      }]), { status: 200, headers: { 'content-type': 'application/json' } }) };
    },
  });
  const res = responseRecorder();
  await api.stations(request('/api/radio/stations?q=jazz&countrycode=us&limit=5000&offset=-4&order=private'), res);
  assert.equal(res.status, 200);
  assert.match(calledUrl, /name=jazz/);
  assert.match(calledUrl, /countrycode=US/);
  assert.match(calledUrl, /limit=100/);
  assert.match(calledUrl, /offset=0/);
  assert.match(calledUrl, /order=clickcount/);
  const data = JSON.parse(res.body);
  assert.equal(data.stations.length, 1);
  assert.equal(data.stations[0].name, 'Radio Jazz');
});

test('Radio Browser API mirror failures fail over and cache repeated directory requests', async () => {
  const requested = [];
  let mirrorTwoCalls = 0;
  const api = createRadioApi({
    mirrors: ['https://one.api.radio-browser.info', 'https://two.api.radio-browser.info'],
    minRequestIntervalMs: 0,
    upstreamFetch: async (url) => {
      requested.push(url);
      if (url.startsWith('https://one.')) throw new Error('mirror offline');
      mirrorTwoCalls += 1;
      return { response: new Response(JSON.stringify([{ stationuuid: '01234567-89ab-cdef-0123-456789abcdef', name: 'Test Station' }]), { status: 200 }) };
    },
  });
  const first = responseRecorder();
  await api.stations(request('/api/radio/stations?q=test'), first);
  const second = responseRecorder();
  await api.stations(request('/api/radio/stations?q=test'), second);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(requested.filter((url) => url.startsWith('https://one.')).length, 1);
  assert.equal(mirrorTwoCalls, 1);
});

test('radio filter options are restricted to the documented directory lists', async () => {
  const calls = [];
  const api = createRadioApi({
    mirrors: ['https://de1.api.radio-browser.info'],
    minRequestIntervalMs: 0,
    upstreamFetch: async (url) => {
      calls.push(url);
      return { response: new Response(JSON.stringify([{ name: 'jazz', stationcount: '20' }]), { status: 200 }) };
    },
  });
  const ok = responseRecorder();
  await api.listOptions(request('/api/radio/options?type=tags'), ok);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).values[0].name, 'jazz');
  const bad = responseRecorder();
  await api.listOptions(request('/api/radio/options?type=unknown'), bad);
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1);
});


test('radio resolve counts station clicks and creates a short-lived ticket for compatible HTTP playback', async () => {
  const calls = [];
  let piped = false;
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const api = createRadioApi({
    mirrors: ['https://de1.api.radio-browser.info'],
    minRequestIntervalMs: 0,
    assertSafeUrl: async () => {},
    upstreamFetch: async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('/json/url/')) {
        return { response: new Response(JSON.stringify({ ok: 'true', stationuuid: uuid, name: 'Test Radio', url: 'http://streams.example/radio.mp3' }), { status: 200 }) };
      }
      return { response: new Response('audio-bytes', { status: 200, headers: { 'content-type': 'audio/mpeg' } }) };
    },
    pipeBody: (response, output) => { piped = true; },
  });
  const resolved = responseRecorder();
  await api.resolveStation(request('/api/radio/resolve/' + uuid), resolved, { uuid });
  assert.equal(resolved.status, 200);
  const payload = JSON.parse(resolved.body);
  assert.equal(payload.url, 'http://streams.example/radio.mp3');
  assert.match(payload.proxyUrl, /^\/api\/radio\/stream\/[A-Za-z0-9_-]+$/);
  assert.match(calls[0].url, /\/json\/url\//);
  const ticket = payload.proxyUrl.split('/').pop();
  const streamed = responseRecorder();
  await api.stream(request('/api/radio/stream/' + ticket), streamed, { ticket });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers['Content-Type'], 'audio/mpeg');
  assert.equal(piped, true);
});

test('radio resolve refuses a private or otherwise unsafe broadcaster endpoint', async () => {
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const api = createRadioApi({
    mirrors: ['https://de1.api.radio-browser.info'],
    minRequestIntervalMs: 0,
    assertSafeUrl: async (url) => {
      if (url.includes('127.0.0.1')) throw Object.assign(new Error('private address blocked'), { statusCode: 403 });
    },
    upstreamFetch: async () => ({
      response: new Response(JSON.stringify({ ok: 'true', url: 'http://127.0.0.1/admin' }), { status: 200 }),
    }),
  });
  const res = responseRecorder();
  await api.resolveStation(request('/api/radio/resolve/' + uuid), res, { uuid });
  assert.equal(res.status, 403);
  assert.match(JSON.parse(res.body).error, /private address blocked/);
});
