'use strict';

// Authenticated, bounded FFmpeg relay for direct MKV/AVI/FLV-style files.
// Input is fetched through the application's SSRF-guarded HTTP client and piped to
// FFmpeg stdin; FFmpeg is not allowed to open arbitrary network URLs itself.
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { upstreamFetch, bodyToString, cancelBody } = require('./fetch-upstream');

const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.TRANSCODE_MAX_CONCURRENT) || 2));
const TRANSCODE_EXT = /\.(mkv|avi|flv|wmv|mpeg|mpg|m2v|3gp|vob)(?:$|[?#])/i;
const MANIFEST_EXT = /\.(m3u8?|mpd)(?:$|[?#])/i;
let active = 0;

function needsTranscode(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return TRANSCODE_EXT.test(url.pathname + url.search) && !MANIFEST_EXT.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function ffmpegArgs() {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'pipe,crypto,data',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-sn', '-dn',
    '-vf', "scale=w='min(1920,iw)':h=-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '4.1',
    '-threads', '2', '-maxrate', '5M', '-bufsize', '10M',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
}

function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

async function handler(req, res, params, query) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    return res.end();
  }
  const target = String(query.u || '');
  if (!target) return fail(res, 400, 'Missing stream URL');
  if (!needsTranscode(target)) return fail(res, 415, 'Transcoding is only for direct MKV, AVI, FLV, WMV, MPEG, VOB or 3GP media files. HLS streams should use the HLS relay.');
  if (active >= MAX_CONCURRENT) return fail(res, 503, 'The transcoder is busy. Try again shortly.');

  let upstream;
  try {
    upstream = await upstreamFetch(target, { timeoutMs: 20000, maxRedirects: 4, range: null });
  } catch (err) {
    return fail(res, err.statusCode || 502, 'Unable to reach the media source safely');
  }
  const { response, url } = upstream;
  if (!response.ok) {
    await cancelBody(response);
    return fail(res, response.status, 'The media source returned HTTP ' + response.status);
  }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('mpegurl') || type.includes('dash+xml') || MANIFEST_EXT.test(new URL(url).pathname)) {
    await cancelBody(response);
    return fail(res, 415, 'Playlist sources are not transcoded by this endpoint');
  }
  if (!response.body) return fail(res, 502, 'Media source returned an empty response');

  let child;
  try {
    child = spawn('ffmpeg', ffmpegArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    await cancelBody(response);
    return fail(res, 503, 'FFmpeg is unavailable on this server');
  }
  active += 1;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk.toString().slice(0, 4000 - stderr.length);
  });
  child.on('error', () => {
    active = Math.max(0, active - 1);
    if (!res.headersSent) fail(res, 503, 'FFmpeg could not start; rebuild the application image');
    else res.destroy();
  });
  child.on('close', (code) => {
    active = Math.max(0, active - 1);
    if (code !== 0 && !res.writableEnded && !res.destroyed) {
      if (!res.headersSent) fail(res, 502, 'Media conversion failed');
      else res.destroy();
    }
  });
  child.stdout.on('error', () => { if (!res.destroyed) res.destroy(); });
  res.on('close', () => {
    if (!res.writableEnded && child.exitCode === null) child.kill('SIGKILL');
  });

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  child.stdout.pipe(res);
  const input = Readable.fromWeb(response.body);
  input.on('error', () => child.stdin.destroy());
  child.stdin.on('error', () => {});
  input.pipe(child.stdin);
}

module.exports = { handler, needsTranscode, ffmpegArgs, MAX_CONCURRENT };
