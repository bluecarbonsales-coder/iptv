'use strict';
// Outbound HTTP with manual redirect handling (so every hop passes the SSRF guard),
// timeouts, transparent decompression, a small origin-scoped cookie jar (some IPTV
// origins hand out a session cookie on the manifest request and 403 the segments
// without it), and a stall guard so a dead upstream cannot hang a client response.
const zlib = require('zlib');
const { pipeline } = require('stream');
const { assertSafeUrl } = require('./util');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- cookie jar: origin (scheme://host:port) -> {cookieString, expires} ----
const JAR = new Map();
const JAR_MAX = 500;
const JAR_TTL_MS = 60 * 60 * 1000;

function jarKey(u) {
  const url = new URL(u);
  return `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
}

function jarGet(u) {
  const hit = JAR.get(jarKey(u));
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    JAR.delete(jarKey(u));
    return null;
  }
  return hit.cookie;
}

function jarStore(u, setCookies) {
  if (!setCookies || !setCookies.length) return;
  const key = jarKey(u);
  let expires = Date.now() + JAR_TTL_MS;
  const parts = [];
  const prev = jarGet(u);
  if (prev) parts.push(prev);
  for (const c of setCookies) {
    const pair = String(c).split(';')[0].trim();
    if (!pair || !pair.includes('=')) continue;
    parts.push(pair);
    const m = /expires=([^;]+)/i.exec(String(c));
    if (m) {
      const d = Date.parse(m[1].trim());
      if (Number.isFinite(d) && d > Date.now()) expires = Math.min(expires, d);
    }
  }
  // de-dupe by cookie name, last value wins
  const byName = new Map();
  for (const p of parts) byName.set(p.slice(0, p.indexOf('=')), p);
  JAR.set(key, { cookie: [...byName.values()].join('; '), expires });
  if (JAR.size > JAR_MAX) {
    const oldest = [...JAR.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) JAR.delete(oldest[0]);
  }
}

async function upstreamFetch(rawUrl, opts = {}) {
  const {
    referrer = null,
    userAgent = null,
    timeoutMs = 20000,
    maxRedirects = 5,
    method = 'GET',
    extraHeaders = {},
    range = null,
    cookies = true,
  } = opts;

  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      'User-Agent': userAgent || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...extraHeaders,
    };
    if (referrer) headers.Referer = referrer;
    if (range) headers.Range = range;
    if (cookies) {
      const jar = jarGet(url);
      if (jar) headers.Cookie = jar;
    }

    let res;
    try {
      res = await fetch(url, { method, headers, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const e = new Error(err.name === 'AbortError' ? 'upstream timeout' : `upstream fetch failed: ${err.message}`);
      e.statusCode = 504;
      throw e;
    }
    clearTimeout(timer);

    if (cookies) {
      try {
        const setCookies =
          typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : res.headers.get('set-cookie')
              ? [res.headers.get('set-cookie')]
              : [];
        jarStore(url, setCookies);
      } catch {}
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      await cancelBody(res);
      if (!loc) {
        const e = new Error('redirect without location');
        e.statusCode = 502;
        throw e;
      }
      url = new URL(loc, url).toString();
      continue;
    }
    return { response: res, url };
  }
  const e = new Error('too many redirects');
  e.statusCode = 502;
  throw e;
}

// Body as string, decompressing when the origin ignored Accept-Encoding: identity.
async function bodyToString(res) {
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (enc.includes('gzip')) return zlib.gunzipSync(buf).toString('utf8');
  if (enc.includes('deflate')) return zlib.inflateSync(buf).toString('utf8');
  if (enc.includes('br')) return zlib.brotliDecompressSync(buf).toString('utf8');
  return buf.toString('utf8');
}

// Pipe an upstream body to the client response.
// - decodes gzip/deflate/br when the origin forced a compressed body
// - stall guard: if no bytes arrive for `stallMs`, the upstream is destroyed
//   (the truncated response ends, hls.js retries the fragment client-side)
function pipeBody(res, out, opts = {}) {
  const { stallMs = 30000, silentErrors = ['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECONNRESET'] } = opts;
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  if (!res.body) {
    out.end();
    return;
  }
  const src = require('stream').Readable.fromWeb(res.body);
  const decoder = enc.includes('gzip')
    ? zlib.createGunzip()
    : enc.includes('deflate')
      ? zlib.createInflate()
      : enc.includes('br')
        ? zlib.createBrotliDecompress()
        : null;
  const stream = decoder ? src.pipe(decoder) : src;

  let stalled = false;
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      try {
        src.destroy();
      } catch {}
    }, stallMs);
  };
  src.on('data', armStall);
  src.on('end', () => clearTimeout(stallTimer));
  src.on('close', () => clearTimeout(stallTimer));
  src.on('error', () => clearTimeout(stallTimer));
  armStall();

  pipeline(stream, out, (err) => {
    clearTimeout(stallTimer);
    // A client that seeks/switches channel aborts the connection constantly: not an error worth logging.
    const code = (err && err.code) || (stalled ? 'STALLED' : '');
    if (err && !silentErrors.includes(code)) {
      try {
        out.destroy();
      } catch {}
    }
  });
}

// Cancel a body we are not going to read. The `await` is the whole point: cancelling a stream
// that has already been read (i.e. locked) REJECTS with ERR_INVALID_STATE per the Web Streams
// spec, and an unhandled rejection terminates the process — a single 404 from an origin used to
// take the whole portal offline. test/upstream-failure-resilience.test.js pins this.
async function cancelBody(res) {
  try {
    await res?.body?.cancel();
  } catch {}
}

module.exports = { upstreamFetch, bodyToString, pipeBody, cancelBody, DEFAULT_UA };
