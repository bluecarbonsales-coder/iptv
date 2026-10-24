'use strict';
// Logo relay with an on-disk cache: many channel logos live on hosts that are slow,
// hotlink-protected or unreachable from the viewer's network, and a 10k-channel grid
// hammers them on every page. Images are small, so buffer-and-cache is enough.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const { mimeFor } = require('./util');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', 'data', 'imgcache');
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ENTRIES = 6000;

const PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#151922"/><text x="60" y="72" font-family="sans-serif" font-size="32" fill="#3d4557" text-anchor="middle">TV</text></svg>';

const keyFor = (url) => crypto.createHash('sha1').update(url).digest('hex');
const cachePath = (url) => {
  const k = keyFor(url);
  return path.join(CACHE_DIR, k.slice(0, 2), k);
};

function footer(res, code, type, body, cache) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function placeholder(res, code = 200) {
  footer(res, code, 'image/svg+xml', PLACEHOLDER, 'public, max-age=3600');
}

function pruneIfNeeded() {
  try {
    const lru = path.join(CACHE_DIR, '.lru');
    const lines = fs.readFileSync(lru, 'utf8').split('\n').filter(Boolean);
    if (lines.length < MAX_ENTRIES) return;
    const keep = new Set(lines.slice(-Math.floor(MAX_ENTRIES / 2)));
    for (const line of new Set(lines)) {
      if (keep.has(line)) continue;
      try {
        fs.unlinkSync(path.join(CACHE_DIR, line.slice(0, 2), line));
      } catch {}
    }
    fs.writeFileSync(lru, [...keep].join('\n') + '\n');
  } catch {}
}

async function handler(req, res, params, query) {
  const url = query.u;
  // Failures answer 404 so the UI can fall back to the channel's initials — that reads
  // better than a wall of identical grey "TV" tiles.
  if (!url) return placeholder(res, 404);

  const cp = cachePath(url);
  try {
    if (fs.existsSync(cp)) {
      const buf = fs.readFileSync(cp);
      return footer(res, 200, mimeFor(url), buf, 'public, max-age=604800, immutable');
    }
  } catch {}

  let upstream;
  try {
    upstream = await upstreamFetch(url, { timeoutMs: 12000, extraHeaders: { Accept: 'image/*,*/*;q=0.8' } });
  } catch {
    return placeholder(res, 404);
  }
  const { response } = upstream;
  const ctype = response.headers.get('content-type') || '';
  if (!response.ok || !/image\//i.test(ctype)) {
    try {
      response.body && response.body.cancel && response.body.cancel();
    } catch {}
    return placeholder(res, 404);
  }

  let buf;
  try {
    const enc = (response.headers.get('content-encoding') || '').toLowerCase();
    if (enc && enc !== 'identity') buf = Buffer.from(await bodyToString(response), 'utf8');
    else buf = Buffer.from(await response.arrayBuffer());
  } catch {
    return placeholder(res);
  }
  if (!buf.length || buf.length > MAX_BYTES) return placeholder(res);

  try {
    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, buf);
    fs.appendFileSync(path.join(CACHE_DIR, '.lru'), keyFor(url) + '\n');
    pruneIfNeeded();
  } catch {}

  return footer(res, 200, ctype.split(';')[0], buf, 'public, max-age=604800, immutable');
}

module.exports = { handler, CACHE_DIR };
