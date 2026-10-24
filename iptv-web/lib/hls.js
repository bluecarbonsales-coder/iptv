'use strict';
// HLS relay: GET /hls?u=<stream url>&r=<referrer>&ua=<user agent>&nc=<skip cache>
//
// Why it exists: browser playback of third-party IPTV streams fails for three reasons
//  1. CORS   - the origin does not send Access-Control-Allow-Origin, so hls.js fetch() dies
//  2. mixed content - the page is https, many IPTV origins are plain http
//  3. geo blocks / referrer checks - the origin wants a specific Referer or another IP
// Relaying every manifest and segment through this server fixes 1 and 2 outright and
// gives the server's network a chance at 3.
const { upstreamFetch, bodyToString, pipeBody } = require('./fetch-upstream');
const { resolveUrl, mimeFor } = require('./util');

const MANIFEST_RE = /\.m3u8?($|\?|#)/i;

function proxyHref(absUrl, opts) {
  const p = new URLSearchParams();
  p.set('u', absUrl);
  if (opts.referrer) p.set('r', opts.referrer);
  if (opts.userAgent) p.set('ua', opts.userAgent);
  if (opts.nocache) p.set('nc', '1');
  return `/hls?${p.toString()}`;
}

// Rewrite every URI in a playlist so the player keeps talking to us.
function rewriteManifest(text, baseUrl, opts) {
  const lines = String(text).split(/\r?\n/);
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // tags may carry one or more URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, EXT-X-I-FRAME-STREAM-INF, EXT-X-SESSION-KEY)
      return line.replace(/URI="([^"]*)"/gi, (m, uri) => {
        const abs = resolveUrl(uri, baseUrl);
        return abs ? `URI="${proxyHref(abs, opts)}"` : m;
      });
    }
    const abs = resolveUrl(t, baseUrl);
    return abs ? proxyHref(abs, opts) : line;
  });
  return out.join('\n');
}

function corsHeaders(extra) {
  return Object.assign(
    {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Allow-Headers': 'Range, Origin, Accept, Content-Type',
    },
    extra || {}
  );
}

function fail(res, code, obj) {
  res.writeHead(code, corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(obj));
}

async function handler(req, res, params, query) {
  const target = query.u;
  if (!target) return fail(res, 400, { error: 'missing u parameter' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const opts = {
    referrer: query.r || null,
    userAgent: query.ua || null,
    nocache: query.nc === '1',
  };

  let upstream;
  try {
    upstream = await upstreamFetch(target, {
      referrer: opts.referrer,
      userAgent: opts.userAgent,
      timeoutMs: 15000,
      range: req.headers.range || null,
      extraHeaders: {
        Accept: req.headers.accept && !/text\/html/.test(req.headers.accept) ? req.headers.accept : '*/*',
      },
    });
  } catch (err) {
    return fail(res, err.statusCode || 502, { error: err.message, upstream: target });
  }

  const { response, url } = upstream;
  const ctype = (response.headers.get('content-type') || '').toLowerCase();
  const looksManifest = ctype.includes('mpegurl') || ctype.includes('x-mpegurl') || MANIFEST_RE.test(url);

  if (!response.ok) {
    // pass the status through, but explain it: the UI shows this text to the user
    const text = await bodyToString(response).catch(() => '');
    try {
      response.body && response.body.cancel && response.body.cancel();
    } catch {}
    return fail(res, response.status, {
      error: `upstream responded ${response.status}`,
      upstream: url,
      detail: text.slice(0, 300),
    });
  }

  if (looksManifest) {
    let text;
    try {
      text = await bodyToString(response);
    } catch (e) {
      return fail(res, 502, { error: `manifest read failed: ${e.message}`, upstream: url });
    }
    if (!/^#EXTM3U/.test(text.trim().slice(0, 40))) {
      return fail(res, 502, {
        error: 'upstream did not return an HLS manifest',
        upstream: url,
        detail: text.slice(0, 200),
      });
    }
    const body = rewriteManifest(text, url, opts);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', // live playlists must never come from a cache
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(body);
  }

  // segment / key / subtitle passthrough
  const isKey = /\.key($|\?|#)/i.test(url);
  const enc = (response.headers.get('content-encoding') || '').toLowerCase();
  const compressed = enc && enc !== 'identity';

  const h = corsHeaders({
    'Cache-Control': req.headers.range ? 'no-store' : 'public, max-age=30',
  });
  const ct = response.headers.get('content-type');
  if (ct && !/text\/html/i.test(ct)) h['Content-Type'] = ct;
  const cr = response.headers.get('content-range');
  if (cr) h['Content-Range'] = cr;
  const ar = response.headers.get('accept-ranges');
  if (ar) h['Accept-Ranges'] = ar;
  // The relay decompresses a compressed body before sending it, so the upstream
  // Content-Length no longer matches the bytes we write: sending it stalls/corrupts
  // playback (the browser waits forever or aborts mid-stream). Without it the
  // response is framed by connection close / chunked encoding, which is correct.
  const cl = response.headers.get('content-length');
  if (cl && !compressed) h['Content-Length'] = cl;
  if (!h['Content-Type']) h['Content-Type'] = isKey ? 'application/octet-stream' : mimeFor(url);

  res.writeHead(response.status, h);
  pipeBody(response, res, { stallMs: 30000 });
}

module.exports = { handler, rewriteManifest, proxyHref };
