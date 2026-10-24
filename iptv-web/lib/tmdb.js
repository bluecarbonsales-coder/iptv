'use strict';
const { sendJson } = require('./util');

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function image(path, size) { return path ? IMAGE_BASE + (size || 'w500') + path : null; }
function normalize(item, type) {
  const mediaType = item.media_type === 'tv' || type === 'tv' ? 'tv' : 'movie';
  return {
    id: item.id, mediaType,
    title: item.title || item.name || 'Untitled',
    originalTitle: item.original_title || item.original_name || '',
    overview: item.overview || '',
    releaseDate: item.release_date || item.first_air_date || '',
    year: String(item.release_date || item.first_air_date || '').slice(0, 4),
    rating: Number.isFinite(item.vote_average) ? item.vote_average : null,
    voteCount: item.vote_count || 0,
    poster: image(item.poster_path, 'w500'),
    backdrop: image(item.backdrop_path, 'w1280'),
    tmdbUrl: 'https://www.themoviedb.org/' + mediaType + '/' + item.id,
    source: 'TMDB'
  };
}
async function request(path, params) {
  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) { const error = new Error('TMDB is not configured. Set TMDB_API_KEY in the private server environment.'); error.statusCode = 503; throw error; }
  const url = new URL(BASE + path);
  url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const cacheKey = url.pathname + '?' + [...url.searchParams.entries()].filter(([k]) => k !== 'api_key').sort().map(([k,v]) => k + '=' + v).join('&');
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;
  const response = await fetch(url.href, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok) { const error = new Error('TMDB returned HTTP ' + response.status); error.statusCode = response.status === 401 ? 502 : 502; throw error; }
  const data = await response.json();
  cache.set(cacheKey, { expires: Date.now() + CACHE_MS, value: data });
  if (cache.size > 250) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
  return data;
}
function createTmdbApi() {
  async function search(req, res, params, query) {
    const q = String(query.q || '').trim().slice(0, 100);
    if (!q) return sendJson(req, res, 400, { error: 'q is required' });
    try {
      const type = ['movie', 'tv', 'multi'].includes(query.type) ? query.type : 'multi';
      const data = await request('/search/' + type, { query: q, include_adult: 'false', page: Math.max(1, Math.min(5, Number(query.page) || 1)), language: String(query.language || 'en-US').slice(0, 12) });
      sendJson(req, res, 200, { results: (data.results || []).filter(x => x.media_type !== 'person').map(x => normalize(x, type === 'tv' ? 'tv' : 'movie')), page: data.page || 1, totalPages: data.total_pages || 0, configured: true });
    } catch (e) { sendJson(req, res, e.statusCode || 502, { error: e.message || 'TMDB request failed' }); }
  }
  async function trending(req, res, params, query) {
    try {
      const window = query.window === 'week' ? 'week' : 'day';
      const type = ['movie', 'tv', 'all'].includes(query.type) ? query.type : 'all';
      const data = await request('/trending/' + type + '/' + window, { language: String(query.language || 'en-US').slice(0, 12), page: 1 });
      sendJson(req, res, 200, { results: (data.results || []).map(x => normalize(x, type === 'tv' ? 'tv' : 'movie')), configured: true });
    } catch (e) { sendJson(req, res, e.statusCode || 502, { error: e.message || 'TMDB request failed' }); }
  }
  async function detail(req, res, params, query) {
    const id = String(params.id || '');
    const type = query.type === 'tv' ? 'tv' : 'movie';
    if (!/^\d{1,12}$/.test(id)) return sendJson(req, res, 400, { error: 'invalid TMDB id' });
    try {
      const [item, providers] = await Promise.all([
        request('/' + type + '/' + id, { language: String(query.language || 'en-US').slice(0, 12) }),
        request('/' + type + '/' + id + '/watch/providers', {})
      ]);
      const normalized = normalize({ ...item, media_type: type }, type);
      sendJson(req, res, 200, { ...normalized, genres: (item.genres || []).map(x => x.name), runtime: item.runtime || null, seasons: item.number_of_seasons || null, networks: (item.networks || []).map(x => x.name), providers: providers.results || {}, homepage: item.homepage || null });
    } catch (e) { sendJson(req, res, e.statusCode || 502, { error: e.message || 'TMDB request failed' }); }
  }
  return { search, trending, detail };
}
module.exports = { createTmdbApi, normalize, image };
