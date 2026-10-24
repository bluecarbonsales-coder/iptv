'use strict';
// Wikimedia Commons adapter for directly playable openly licensed video files.
// This surfaces only CC0, Public Domain, CC BY, and CC BY-SA declarations; verify each file page.
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const API = 'https://commons.wikimedia.org/w/api.php';
const MAX_BYTES = 5 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogg)$/i;

function clean(value) {
  return String(value == null ? '' : value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}
function metaValue(metadata, key) {
  const value = metadata && metadata[key];
  return clean(value && typeof value === 'object' ? value.value : value);
}
function licenseInfo(meta = {}) {
  const url = metaValue(meta, 'LicenseUrl').toLowerCase();
  const name = metaValue(meta, 'LicenseShortName').toLowerCase();
  const terms = metaValue(meta, 'UsageTerms').toLowerCase();
  if (/by-nc|noncommercial|non-commercial/.test(url + ' ' + name + ' ' + terms)) return null;
  if (/creativecommons\.org\/publicdomain\/(?:zero|mark)\//.test(url) || /\bcc0\b|public domain|pdm/.test(name + ' ' + terms)) {
    return { label: name || 'Public domain / CC0', url: url || null };
  }
  if (/creativecommons\.org\/licenses\/by(?:-sa)?\//.test(url) || /\bcc by(?:-sa)?\b/.test(name)) {
    return { label: name || 'Creative Commons Attribution', url: url || null };
  }
  return null;
}
function classify(title, description = '') {
  return /anime|animation|animated|cartoon|manga/i.test(clean(title + ' ' + description)) ? 'anime' : 'movies';
}
function normalizePage(page) {
  const info = page && page.imageinfo && page.imageinfo[0];
  if (!page || !info || !info.url || !VIDEO_EXT.test(info.url.split('?')[0])) return null;
  const metadata = info.extmetadata || {};
  const license = licenseInfo(metadata);
  if (!license) return null;
  const fileTitle = String(page.title || '').replace(/^File:/i, '');
  const id = String(page.pageid || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const description = metaValue(metadata, 'ImageDescription') || clean(page.extract || '');
  const artist = metaValue(metadata, 'Artist');
  const attribution = artist ? 'By ' + artist : '';
  const pageUrl = 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(page.title || '').replace(/ /g, '_'));
  return {
    id,
    key: 'commons:' + id,
    sourceId: 'commons',
    sourceName: 'Wikimedia Commons',
    name: fileTitle.replace(/\.[^.]+$/, '').replace(/_/g, ' ') || fileTitle,
    logo: info.thumburl || null,
    overview: description.slice(0, 1000),
    year: '',
    category: clean([metaValue(metadata, 'Categories'), attribution].filter(Boolean).join(' · ')),
    remarks: license.label,
    licenseUrl: license.url,
    pageUrl,
    kind: classify(fileTitle, description),
    vod: true,
    episodes: [{ title: 'Original video', url: info.url }],
  };
}
async function fetchJson(url) {
  const { response } = await upstreamFetch(url, {
    timeoutMs: 15000,
    userAgent: 'IPTV-Web/1.0 (open-license video catalog; https://iptv.nafisainternational.com)',
    extraHeaders: {
      Accept: 'application/json',
      'Api-User-Agent': 'IPTV-Web/1.0 (open-license video catalog; https://iptv.nafisainternational.com) Node.js',
    },
  });
  if (!response.ok) throw Object.assign(new Error('Wikimedia Commons returned HTTP ' + response.status), { statusCode: 502 });
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw Object.assign(new Error('Wikimedia response too large'), { statusCode: 502 });
  const text = await bodyToString(response);
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw Object.assign(new Error('Wikimedia response too large'), { statusCode: 502 });
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Wikimedia returned invalid JSON'), { statusCode: 502 }); }
}
function safeQuery(q) {
  return clean(q).replace(/[\[\]{}|<>]/g, ' ').slice(0, 140);
}
async function search(query = '', type = 'all', limit = 25) {
  if (!['all', 'movies', 'series', 'anime'].includes(type)) type = 'all';
  if (type === 'series') return [];
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    gsrnamespace: '6',
    gsrlimit: String(Math.min(50, Math.max(1, limit * 2))),
    gsrsearch: (safeQuery(query) + ' filetype:video').trim(),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '320',
  });
  const payload = await fetchJson(API + '?' + params.toString());
  const pages = Array.isArray(payload && payload.query && payload.query.pages) ? payload.query.pages : [];
  const results = [];
  const seen = new Set();
  for (const page of pages) {
    const item = normalizePage(page);
    if (!item || seen.has(item.id)) continue;
    if (type !== 'all' && item.kind !== type) continue;
    seen.add(item.id);
    results.push(item);
    if (results.length >= Math.min(40, Math.max(1, limit))) break;
  }
  return results;
}
async function getDetail(pageid) {
  if (!/^\d+$/.test(String(pageid))) throw Object.assign(new Error('Invalid Commons page ID'), { statusCode: 400 });
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    pageids: String(pageid),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '320',
  });
  const payload = await fetchJson(API + '?' + params.toString());
  const pages = payload && payload.query && Array.isArray(payload.query.pages) ? payload.query.pages : [];
  const item = pages.map(normalizePage).find(Boolean);
  if (!item) throw Object.assign(new Error('This Commons file is not an explicitly supported open-license video'), { statusCode: 403 });
  return item;
}
module.exports = { API, VIDEO_EXT, clean, metaValue, licenseInfo, classify, normalizePage, search, getDetail };
