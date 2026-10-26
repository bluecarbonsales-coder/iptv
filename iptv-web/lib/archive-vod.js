'use strict';
// Internet Archive VOD adapter. Search results are shown only when metadata declares
// public-domain status or a compatible CC license; rights still need verification by users.
const { upstreamFetch, bodyToString } = require('./fetch-upstream');

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const META_ENDPOINT = 'https://archive.org/metadata/';
const MAX_BYTES = 4 * 1024 * 1024;
const APPROVED_EXT = /\.(mp4|m4v|webm|ogv|ogg)$/i;
// Open-license collections worth paging through instead of one broad
// "mediatype:movies" query (which returns only the most-downloaded titles).
// Rights still come from each item's own metadata: the query filter below only
// pre-selects candidates, licenseInfo() decides what may be listed.
const COLLECTIONS = [
  { id: 'feature_films', label: 'Feature Films', kind: 'movies' },
  { id: 'moviesandfilms', label: 'Movies and Films', kind: 'movies' },
  { id: 'film_noir', label: 'Film Noir', kind: 'movies' },
  { id: 'SciFi_Horror', label: 'Sci-Fi and Horror', kind: 'movies' },
  { id: 'silent_films', label: 'Silent Films', kind: 'movies' },
  { id: 'animationandcartoons', label: 'Animation and Cartoons', kind: 'anime' },
  { id: 'classic_cartoons', label: 'Classic Cartoons', kind: 'anime' },
  { id: 'documentaryfilms', label: 'Documentary Films', kind: 'documentary' },
  { id: 'prelinger', label: 'Prelinger Archives', kind: 'documentary' },
  { id: 'classic_tv', label: 'Classic TV', kind: 'series' },
];
const MAX_ROWS = 100;

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { result[index] = { status: 'fulfilled', value: await fn(items[index], index) }; }
      catch (reason) { result[index] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return result;
}

function cleanText(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item == null ? '' : item)).join(' · ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
function licenseInfo(doc = {}) {
  const licenseUrl = cleanText(doc.licenseurl || doc.license_url).toLowerCase();
  const rights = cleanText(doc.rights || doc.license || doc.license_name).toLowerCase();
  if (/creativecommons\.org\/licenses\/by-nc(?:-|\/)|creativecommons\.org\/licenses\/by-nc-sa|creativecommons\.org\/licenses\/by-nc-nd/.test(licenseUrl)) return null;
  if (/creativecommons\.org\/publicdomain\/(?:zero|mark)\//.test(licenseUrl) || /\bcc0\b|public domain mark|dedicated to the public domain/.test(rights)) {
    return { label: 'Public domain / CC0', url: licenseUrl || null };
  }
  if (/creativecommons\.org\/licenses\/by(?:-sa|-nd)?\//.test(licenseUrl) || /creativecommons? attribution(?:-sharealike|-no derivatives)?\b/.test(rights)) {
    return { label: 'Creative Commons', url: licenseUrl || null };
  }
  if (/public domain/.test(rights) && !/not public domain|no public domain|public domain status unknown/.test(rights)) {
    return { label: 'Public domain (declared by Archive metadata)', url: licenseUrl || null };
  }
  return null;
}
function identifierOf(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) ? id : null;
}
function classify(doc = {}) {
  const label = cleanText([doc.title, doc.subject, doc.description].filter(Boolean).join(' ')).toLowerCase();
  return /anime|japanese animation|animation film|animated cartoon|animated film|cartoon/.test(label) ? 'anime' : 'movies';
}
function normalizedDoc(doc) {
  const id = identifierOf(doc.identifier);
  const license = licenseInfo(doc);
  if (!id || !license || !doc.title) return null;
  return {
    id,
    key: 'archive:' + id,
    sourceId: 'archive',
    sourceName: 'Internet Archive',
    name: cleanText(doc.title) || id,
    logo: 'https://archive.org/services/img/' + encodeURIComponent(id),
    overview: cleanText(doc.description || ''),
    year: cleanText(doc.year || doc.date || ''),
    category: cleanText(doc.subject || ''),
    remarks: license.label,
    licenseUrl: license.url,
    pageUrl: 'https://archive.org/details/' + encodeURIComponent(id),
    kind: classify(doc),
    vod: true,
  };
}
async function fetchJson(url, maxBytes = MAX_BYTES) {
  const { response } = await upstreamFetch(url, {
    timeoutMs: 18000,
    extraHeaders: { Accept: 'application/json' },
  });
  if (!response.ok) throw Object.assign(new Error('Internet Archive returned HTTP ' + response.status), { statusCode: 502 });
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw Object.assign(new Error('Internet Archive response too large'), { statusCode: 502 });
  const raw = await bodyToString(response);
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw Object.assign(new Error('Internet Archive response too large'), { statusCode: 502 });
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Internet Archive returned invalid JSON'), { statusCode: 502 }); }
}
function escapeLucene(value) {
  return String(value || '').replace(/[^\p{L}\p{N}\s.'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100).replace(/"/g, '');
}
async function search(query = '', type = 'all', limit = 30, options = {}) {
  if (!['all', 'movies', 'series', 'anime', 'documentary'].includes(type)) type = 'all';
  const params = new URLSearchParams();
  const term = escapeLucene(query);
  // Only the leading-wildcard forms are accepted by the Archive search parser:
  // "licenseurl:http*licenses/by*" makes advancedsearch.php answer without a
  // response.docs block (that silently emptied the open-license fallback before).
  // Rights are still decided per item by licenseInfo(), which rejects NC/ND.
  const rights = '(licenseurl:*publicdomain* OR licenseurl:*zero* OR licenseurl:*creativecommons* OR rights:"Public Domain")';
  const textFilter = term ? ' AND (title:"' + term + '" OR subject:"' + term + '")' : '';
  const collection = String(options.collection || '').replace(/[^A-Za-z0-9_.-]/g, '');
  params.set('q', 'mediatype:movies AND ' + rights + (collection ? ' AND collection:' + collection : '') + textFilter);
  for (const field of ['identifier', 'title', 'year', 'date', 'description', 'creator', 'licenseurl', 'rights', 'subject']) params.append('fl[]', field);
  params.set('sort[]', options.sort || 'downloads desc');
  params.set('rows', String(Math.max(1, Math.min(MAX_ROWS, options.rows || limit * 2))));
  params.set('page', String(Math.max(1, Number.parseInt(options.page, 10) || 1)));
  params.set('output', 'json');
  const payload = await fetchJson(SEARCH_ENDPOINT + '?' + params.toString());
  const docs = payload && payload.response && Array.isArray(payload.response.docs) ? payload.response.docs : [];
  const found = [];
  const seen = new Set();
  for (const doc of docs) {
    const item = normalizedDoc(doc);
    if (!item || seen.has(item.id)) continue;
    if (type !== 'all' && item.kind !== type) continue;
    seen.add(item.id);
    found.push(item);
    if (found.length >= limit) break;
  }
  return found;
}
// Page through the curated open-license collections so the persisted catalogue grows
// past the handful of titles a single ranked query returns.
async function harvest(options = {}) {
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? options.kinds : ['movies', 'anime', 'documentary'];
  const pages = Math.max(1, Math.min(10, options.pages || 2));
  const rows = Math.max(1, Math.min(MAX_ROWS, options.rows || 50));
  const collections = (options.collections || COLLECTIONS).filter((collection) => kinds.includes(collection.kind));
  const results = await mapLimit(collections, Math.max(1, Math.min(4, options.concurrency || 3)), async (collection) => {
    const found = [];
    for (let page = 1; page <= pages; page += 1) {
      const items = await search('', collection.kind, rows, { page, rows, collection: collection.id, sort: options.sort });
      for (const item of items) found.push({ ...item, collection: collection.id, collectionLabel: collection.label });
      if (items.length < rows) break;
    }
    return found;
  });
  const byId = new Map();
  const errors = [];
  results.forEach((result, index) => {
    if (!result || result.status !== 'fulfilled') {
      errors.push({ collection: collections[index] && collections[index].id, error: String(result && result.reason && result.reason.message || 'collection search failed').slice(0, 160) });
      return;
    }
    for (const item of result.value) if (!byId.has(item.id)) byId.set(item.id, item);
  });
  const items = [...byId.values()];
  items.errors = errors;
  return items;
}

function encodedPath(value) {
  return String(value || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}
function playableFiles(files = []) {
  const candidates = files.filter((file) => file && typeof file.name === 'string' && APPROVED_EXT.test(file.name) && !file.name.startsWith('__ia_thumb'));
  const score = (file) => {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
    const media = String(file.format || '').toLowerCase();
    return (ext === '.mp4' ? 50 : ext === '.webm' ? 40 : ext === '.m4v' ? 30 : 20) + (/mpeg4|h\.264|h264|webm/.test(media) ? 5 : 0);
  };
  return candidates.sort((a, b) => score(b) - score(a));
}
async function getDetail(identifier) {
  const id = identifierOf(identifier);
  if (!id) throw Object.assign(new Error('Invalid Internet Archive identifier'), { statusCode: 400 });
  const payload = await fetchJson(META_ENDPOINT + encodeURIComponent(id));
  const metadata = payload && payload.metadata || {};
  if (metadata.mediatype !== 'movies') throw Object.assign(new Error('Archive item is not a movie/video entry'), { statusCode: 404 });
  const item = normalizedDoc({
    identifier: id,
    title: metadata.title,
    year: metadata.year,
    date: metadata.date,
    description: metadata.description,
    creator: metadata.creator,
    subject: metadata.subject,
    licenseurl: metadata.licenseurl,
    rights: metadata.rights,
  });
  if (!item) throw Object.assign(new Error('This item has no explicit public-domain or supported Creative Commons metadata; refusing to stream it automatically'), { statusCode: 403 });
  const files = playableFiles(payload.files || []);
  const file = files.find((candidate) => !candidate.private && candidate.source !== 'original') || files.find((candidate) => !candidate.private);
  if (!file) throw Object.assign(new Error('No browser-compatible MP4/WebM/Ogg video file found'), { statusCode: 404 });
  const url = 'https://archive.org/download/' + encodeURIComponent(id) + '/' + encodedPath(file.name);
  return {
    ...item,
    episodes: [{ title: file.name, url }],
    pageUrl: 'https://archive.org/details/' + encodeURIComponent(id),
    fileName: file.name,
  };
}
module.exports = { SEARCH_ENDPOINT, META_ENDPOINT, APPROVED_EXT, COLLECTIONS, MAX_ROWS, cleanText, licenseInfo, identifierOf, classify, normalizedDoc, escapeLucene, search, harvest, playableFiles, getDetail };
