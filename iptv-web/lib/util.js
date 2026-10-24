'use strict';
// Small shared helpers: mime map, JSON/compressed responses, SSRF guard, URL resolve.
const zlib = require('zlib');
const net = require('net');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.m3u': 'audio/x-mpegurl',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.m4v': 'video/x-m4v',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function mimeFor(p) {
  return MIME[path.extname(String(p || '')).toLowerCase()] || 'application/octet-stream';
}

function wantsGzip(req, type) {
  const ae = String(req.headers['accept-encoding'] || '');
  return /gzip/.test(ae) && /^(text|application\/json|image\/svg|application\/javascript|text\/javascript)/.test(type || 'application/json');
}

function send(req, res, code, body, type, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = Object.assign(
    {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
    extraHeaders || {}
  );
  if (buf.length > 1024 && wantsGzip(req, type)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(code, headers);
    res.end(gz);
    return;
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function sendJson(req, res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  send(req, res, code, body, 'application/json; charset=utf-8', extraHeaders);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([net_, bits]) => ({ net: ipv4ToInt(net_), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

function isPrivateIp(ip) {
  if (!ip) return true;
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    const v = ipv4ToInt(addr);
    return V4_BLOCKS.some((b) => (v & b.mask) >>> 0 === (b.net & b.mask) >>> 0);
  }
  const low = addr.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (/^f[cd]/.test(low)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(low)) return true; // link local
  if (low.startsWith('ff')) return true; // multicast
  return false;
}

// SSRF guard for every outbound URL the proxy follows.
async function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('bad url'), { statusCode: 400 });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('only http(s) allowed'), { statusCode: 400 });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw Object.assign(new Error('host not allowed'), { statusCode: 403 });
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw Object.assign(new Error('private address blocked'), { statusCode: 403 });
    return u;
  }
  const dns = require('dns').promises;
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error('dns lookup failed'), { statusCode: 502 });
  }
  if (!addrs.length) throw Object.assign(new Error('dns lookup empty'), { statusCode: 502 });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw Object.assign(new Error('resolves to private address'), { statusCode: 403 });
  }
  return u;
}

function resolveUrl(ref, base) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function escapeXml(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  mimeFor,
  send,
  sendJson,
  readBody,
  isPrivateIp,
  assertSafeUrl,
  resolveUrl,
  normalize,
  escapeXml,
  clampInt,
};
