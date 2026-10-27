'use strict';
// Static file serving for public/ with etags, compression and a light path guard.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { mimeFor } = require('./util');
const { send } = require('./util');

const COMPRESSIBLE = /^(text|application\/(json|javascript|manifest\+json)|image\/svg)/;

// ?v=<mtime> for root-absolute script/stylesheet references, so a deploy invalidates the URL a
// browser already holds. References that do not resolve to a file under public/ are left alone.
const ASSET_REF = /(\s(?:src|href)=["'])(\/(?!\/)[^"'?#]+\.(?:js|css))(["'])/g;
function stampAssets(html, rootDir) {
  return html.replace(ASSET_REF, (match, pre, url, post) => {
    try {
      const abs = path.join(rootDir, url.replace(/^\/+/, ''));
      if (!abs.startsWith(rootDir)) return match;
      return `${pre}${url}?v=${Math.round(fs.statSync(abs).mtimeMs)}${post}`;
    } catch {
      return match;
    }
  });
}

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
    // Code and markup must not outlive a deploy in browser caches: /app.js used to carry
    // max-age=86400, so a fixed player kept serving the broken file for a day after the fix.
    // These revalidate (the ETag above still answers 304 when nothing changed); images, fonts
    // and vendored bundles keep the long cache.
    const revalidate = /^text\/html/.test(type) || /\.(?:js|css|json|webmanifest|map)$/i.test(abs);
    const headers = {
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=86400',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Access-Control-Allow-Origin': '*',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    headers['Content-Type'] = type;

    const body = /^text\/html/.test(type)
      ? Buffer.from(stampAssets(fs.readFileSync(abs, 'utf8'), rootDir))
      : null;
    const size = body ? body.length : stat.size;

    const useGzip = options.gzip !== false && COMPRESSIBLE.test(type) && /gzip/.test(req.headers['accept-encoding'] || '');
    if (useGzip && size > 800) {
      // Stamped HTML is deliberately not cached here: its bytes also depend on the assets'
      // mtimes, which this page's etag does not cover. Pages are ~10 KB, so re-gzipping is free.
      let buf = body ? null : gzCache.get(etag);
      if (!buf) {
        buf = zlib.gzipSync(body || fs.readFileSync(abs), { level: 6 });
        if (!body) {
          if (gzCache.size > 60) gzCache.clear();
          gzCache.set(etag, buf);
        }
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : buf);
    }
    headers['Content-Length'] = size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    return body ? res.end(body) : fs.createReadStream(abs).pipe(res);
  };
}

module.exports = { serveStatic, send };
