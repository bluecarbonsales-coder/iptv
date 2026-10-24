'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { sendJson, readBody } = require('./util');
const archive = require('./archive-vod');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');

const MAX_SAVED = 1000;
function matchesToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validateUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!['http:', 'https:', 'magnet:'].includes(u.protocol)) return null;
    if (u.protocol === 'magnet:') return /^magnet:\?xt=urn:btih:[a-z0-9]{32,64}/i.test(u.href) ? u.href : null;
    if (u.username || u.password || u.href.length > 2048) return null;
    return u.href;
  } catch { return null; }
}
function readSaved(dataDir) {
  const file = path.join(dataDir, 'media-links.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.links) ? parsed.links : [];
  } catch (e) { if (e.code !== 'ENOENT') console.error('media links read failed:', e.message); return []; }
}
function writeSaved(dataDir, links) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'media-links.json');
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, links }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function createMediaDiscovery({ dataDir }) {
  const linksPath = () => path.join(dataDir, 'media-links.json');
  function authorize(req, res) {
    const expected = process.env.SOURCE_TOKEN || process.env.REFRESH_TOKEN || process.env.AGENT_API_TOKEN || '';
    if (!matchesToken(req.headers['x-source-token'] || req.headers['x-agent-token'], expected)) {
      sendJson(req, res, expected ? 403 : 503, { error: expected ? 'management token required' : 'configure SOURCE_TOKEN, REFRESH_TOKEN, or AGENT_API_TOKEN first' });
      return false;
    }
    return true;
  }
  async function search(req, res, params, query) {
    const q = String(query.q || '').trim().slice(0, 100);
    if (!q) return sendJson(req, res, 400, { error: 'q is required' });
    const sources = String(query.sources || 'archive,jackett').split(',').filter((s) => ['archive', 'jackett', 'saved'].includes(s));
    const results = [], errors = [];
    if (sources.includes('archive')) {
      try {
        const found = await archive.search(q, 'all', 15);
        for (const item of found) results.push({ id: item.key, title: item.name, source: item.sourceName, kind: 'public-domain', url: item.pageUrl, license: item.remarks, playable: true, streamUrl: null, description: item.overview, year: item.year });
      } catch (e) { errors.push({ source: 'Internet Archive', error: e.message }); }
    }
    if (sources.includes('saved')) {
      for (const feed of readSaved(dataDir).filter((item) => item.kind === 'feed').slice(0, 10)) {
        try {
          const { response } = await upstreamFetch(feed.url, { timeoutMs: 10000, maxRedirects: 3, extraHeaders: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const xml = await bodyToString(response);
          if (Buffer.byteLength(xml) > 1024 * 1024) throw new Error('Feed too large');
          const entries = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
          for (const entry of entries.slice(0, 20)) {
            const titleMatch = entry.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
            const linkMatch = entry.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i) || entry.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i) || entry.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/i);
            const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() : '';
            const url = validateUrl(linkMatch && (linkMatch[1] || linkMatch[0]).trim());
            if (title && url && /^https?:/i.test(url)) results.push({ id: 'feed:' + crypto.createHash('sha1').update(feed.id + url).digest('hex').slice(0, 16), title, source: feed.title, kind: 'feed-link', url, playable: /\.(mp4|webm|m3u8)(?:$|\?)/i.test(url), description: 'From your saved feed. Check the original page for availability and rights.' });
          }
        } catch (e) { errors.push({ source: feed.title, error: e.message }); }
      }
    }
    if (sources.includes('jackett')) {
      const base = String(process.env.JACKETT_URL || '').trim().replace(/\/+$/, '');
      const key = String(process.env.JACKETT_API_KEY || '').trim();
      if (base && key) {
        try {
          const endpoint = new URL('/api/v2.0/indexers/all/results/torznab/api', base);
          endpoint.searchParams.set('apikey', key);
          endpoint.searchParams.set('t', 'search');
          endpoint.searchParams.set('q', q);
          endpoint.searchParams.set('limit', '30');
          const response = await fetch(endpoint.href, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'application/xml, text/xml' } });
          if (!response.ok) throw new Error('Jackett returned HTTP ' + response.status);
          const xml = await response.text();
          if (Buffer.byteLength(xml) > 2 * 1024 * 1024) throw new Error('Jackett response too large');
          const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
          for (const item of items.slice(0, 30)) {
            const get = (tag) => { const m = item.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim() : ''; };
            const attrs = item.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i);
            const link = get('link') || (attrs ? attrs[1] : '');
            const title = get('title');
            const magnet = (item.match(/magnet:\?[^"'\s<]+/i) || [])[0] || '';
            const url = validateUrl(magnet || link);
            if (!title || !url) continue;
            results.push({ id: 'jackett:' + crypto.createHash('sha1').update(title + url).digest('hex').slice(0, 16), title, source: get('jackettindexer') || 'Jackett indexer', kind: /magnet:/i.test(url) ? 'torrent' : 'link', url, playable: false, streamUrl: null, description: 'External result. Verify availability and rights at the source.' });
          }
        } catch (e) { errors.push({ source: 'Jackett', error: e.message }); }
      } else errors.push({ source: 'Jackett', error: 'Not configured. Set JACKETT_URL and JACKETT_API_KEY in the server environment.' });
    }
    const seen = new Set();
    const unique = results.filter((item) => { const key = item.url || item.title; if (seen.has(key)) return false; seen.add(key); return true; });
    sendJson(req, res, 200, { query: q, results: unique, errors, sources: { archive: sources.includes('archive'), jackett: sources.includes('jackett'), saved: sources.includes('saved'), jackettConfigured: !!(process.env.JACKETT_URL && process.env.JACKETT_API_KEY) } });
  }
  function list(req, res) {
    if (!authorize(req, res)) return;
    sendJson(req, res, 200, { links: readSaved(dataDir) });
  }
  async function add(req, res) {
    if (!authorize(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 16384));
      const title = String(body.title || '').trim().slice(0, 180);
      const url = validateUrl(body.url);
      if (!title || !url) return sendJson(req, res, 400, { error: 'title and a valid HTTP(S) or magnet URL are required' });
      const links = readSaved(dataDir);
      if (links.length >= MAX_SAVED) return sendJson(req, res, 409, { error: 'saved link limit reached' });
      if (links.some((item) => item.url === url)) return sendJson(req, res, 409, { error: 'link already saved', existing: links.find((item) => item.url === url) });
      const item = { id: crypto.randomUUID(), title, url, kind: String(body.kind || 'link').slice(0, 40), source: String(body.source || 'Saved manually').slice(0, 100), notes: String(body.notes || '').trim().slice(0, 1000), watched: false, createdAt: new Date().toISOString() };
      links.unshift(item); writeSaved(dataDir, links);
      sendJson(req, res, 201, { link: item });
    } catch (e) { sendJson(req, res, e.statusCode || 400, { error: e.message || 'invalid request' }); }
  }
  async function update(req, res, params) {
    if (!authorize(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 8192));
      const links = readSaved(dataDir), item = links.find((x) => x.id === params.id);
      if (!item) return sendJson(req, res, 404, { error: 'saved link not found' });
      if (body.watched !== undefined) item.watched = !!body.watched;
      if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 1000);
      writeSaved(dataDir, links); sendJson(req, res, 200, { link: item });
    } catch (e) { sendJson(req, res, 400, { error: e.message || 'invalid request' }); }
  }
  function remove(req, res, params) {
    if (!authorize(req, res)) return;
    const links = readSaved(dataDir), next = links.filter((x) => x.id !== params.id);
    if (next.length === links.length) return sendJson(req, res, 404, { error: 'saved link not found' });
    writeSaved(dataDir, next); sendJson(req, res, 200, { removed: true });
  }
  return { search, list, add, update, remove };
}
module.exports = { createMediaDiscovery, validateUrl, readSaved, writeSaved, matchesToken, MAX_SAVED };
