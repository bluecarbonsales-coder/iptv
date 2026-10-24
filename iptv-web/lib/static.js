'use strict';
// Static file serving for public/ with etags, compression and a light path guard.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { mimeFor } = require('./util');
const { send } = require('./util');

const COMPRESSIBLE = /^(text|application\/(json|javascript|manifest\+json)|image\/svg)/;

function serveStatic(rootDir, options = {}) {
  const gzCache = new Map();
  return async function (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      urlPath = req.url.split('?')[0];
    }
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
    const rel = path.normalize(urlPath).replace(/^([.]{2}[/\\])+/, '').replace(/^[/\\]+/, '');
    const abs = path.join(rootDir, rel);
    if (!abs.startsWith(rootDir)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return false; // fall through to the caller's 404 handler
    }
    if (stat.isDirectory()) return false;

    const type = mimeFor(abs);
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    const headers = {
      'Cache-Control': /(?:index|watch)\.html$/.test(abs) ? 'no-cache' : 'public, max-age=86400',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Access-Control-Allow-Origin': '*',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Type'] = type;

    const useGzip = options.gzip !== false && COMPRESSIBLE.test(type) && /gzip/.test(req.headers['accept-encoding'] || '');
    if (useGzip && stat.size > 800) {
      let buf = gzCache.get(etag);
      if (!buf) {
        buf = zlib.gzipSync(fs.readFileSync(abs), { level: 6 });
        if (gzCache.size > 60) gzCache.clear();
        gzCache.set(etag, buf);
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(abs).pipe(res);
  };
}

module.exports = { serveStatic, send };
