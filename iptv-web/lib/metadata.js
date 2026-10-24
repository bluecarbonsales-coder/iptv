'use strict';

const { sendJson } = require('./util');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const OMDB_BASE = 'https://www.omdbapi.com/';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

function createMetadataApi({ fetchImpl = globalThis.fetch, env = process.env, now = Date.now } = {}) {
  const cache = new Map();

  function cached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  function store(key, value) {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
    return value;
  }

  async function requestJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'IPTV-Web-Metadata/1.0' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = new Error('Metadata provider request failed');
        err.status = response.status === 429 ? 429 : 502;
        throw err;
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function tmdb(path, params = {}) {
    if (!env.TMDB_API_KEY) throw Object.assign(new Error('TMDB is not configured'), { status: 503 });
    const url = new URL(TMDB_BASE + path);
    url.searchParams.set('api_key', env.TMDB_API_KEY);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return requestJson(url);
  }

  async function omdb(params = {}) {
    if (!env.OMDB_API_KEY) throw Object.assign(new Error('OMDb is not configured'), { status: 503 });
    const url = new URL(OMDB_BASE);
    url.searchParams.set('apikey', env.OMDB_API_KEY);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return requestJson(url);
  }

  async function search(req, res, params, query) {
    const q = String(query.q || '').trim();
    if (q.length < 2 || q.length > 100) return sendJson(req, res, 400, { error: 'q must contain 2–100 characters' });
    const page = Math.max(1, Math.min(5, Number.parseInt(query.page, 10) || 1));
    const key = 'search:' + q.toLowerCase() + ':' + page;
    try {
      const hit = cached(key);
      if (hit) return sendJson(req, res, 200, hit);
      const data = await tmdb('/search/multi', { query: q, page, include_adult: 'false' });
      const results = (Array.isArray(data.results) ? data.results : [])
        .filter(item => item && ['movie', 'tv'].includes(item.media_type))
        .map(item => ({
          id: item.id,
          mediaType: item.media_type,
          title: item.title || item.name || '',
          originalTitle: item.original_title || item.original_name || '',
          overview: item.overview || '',
          releaseDate: item.release_date || item.first_air_date || '',
          posterPath: item.poster_path || null,
          backdropPath: item.backdrop_path || null,
          voteAverage: Number.isFinite(item.vote_average) ? item.vote_average : null,
          tmdbUrl: 'https://www.themoviedb.org/' + (item.media_type === 'tv' ? 'tv/' : 'movie/') + encodeURIComponent(item.id),
        }));
      return sendJson(req, res, 200, store(key, { page, totalPages: Math.min(5, data.total_pages || 1), results }));
    } catch (error) {
      const status = error.status || 502;
      return sendJson(req, res, status, { error: status === 429 ? 'Metadata provider rate limit reached' : status === 503 ? error.message : 'TMDB search unavailable' });
    }
  }

  async function tvmazeSearch(req, res, params, query) {
    const q = String(query.q || '').trim();
    if (q.length < 2 || q.length > 100) return sendJson(req, res, 400, { error: 'q must contain 2–100 characters' });
    const key = 'tvmaze:' + q.toLowerCase();
    try {
      const hit = cached(key);
      if (hit) return sendJson(req, res, 200, hit);
      const url = new URL('https://api.tvmaze.com/search/shows');
      url.searchParams.set('q', q);
      const data = await requestJson(url);
      const results = (Array.isArray(data) ? data : []).slice(0, 20).map(row => {
        const show = row && row.show ? row.show : {};
        return { id: show.id, title: show.name || '', summary: String(show.summary || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), genres: Array.isArray(show.genres) ? show.genres : [], status: show.status || null, premiered: show.premiered || null, ended: show.ended || null, rating: show.rating && Number.isFinite(show.rating.average) ? show.rating.average : null, image: show.image && (show.image.medium || show.image.original) || null, url: show.url || null };
      });
      return sendJson(req, res, 200, store(key, { provider: 'tvmaze', attribution: 'TVmaze', results }));
    } catch (error) {
      const status = error.status || 502;
      return sendJson(req, res, status, { error: status === 429 ? 'TVmaze rate limit reached; retry shortly' : 'TVmaze search unavailable' });
    }
  }

  async function title(req, res, params, query) {
    const imdbId = String(query.imdbId || '').trim();
    const titleText = String(query.t || '').trim();
    const year = String(query.y || '').trim();
    if ((!imdbId && !titleText) || imdbId.length > 20 || titleText.length > 100 || (year && !/^\\d{4}$/.test(year))) {
      return sendJson(req, res, 400, { error: 'Provide imdbId or t (max 100 characters); y must be a four-digit year' });
    }
    if (imdbId && !/^tt\\d{5,12}$/.test(imdbId)) return sendJson(req, res, 400, { error: 'Invalid IMDb ID' });
    const key = 'title:' + (imdbId || titleText.toLowerCase()) + ':' + year;
    try {
      const hit = cached(key);
      if (hit) return sendJson(req, res, 200, hit);
      let omdbData = null;
      try {
        omdbData = await omdb(imdbId ? { i: imdbId, plot: 'full' } : { t: titleText, y: year, plot: 'full' });
        if (omdbData && omdbData.Response === 'False') omdbData = null;
      } catch (error) {
        if (error.status === 429) throw error;
      }
      let tmdbData = null;
      try {
        if (imdbId) {
          const found = await tmdb('/find/' + encodeURIComponent(imdbId), { external_source: 'imdb_id' });
          const item = (found.movie_results || [])[0] || (found.tv_results || [])[0];
          if (item) {
            const type = item.media_type || (found.tv_results && found.tv_results.length ? 'tv' : 'movie');
            tmdbData = await tmdb('/' + (type === 'tv' ? 'tv/' : 'movie/') + item.id);
            tmdbData.media_type = type;
          }
        } else {
          const found = await tmdb('/search/multi', { query: titleText, year, include_adult: 'false' });
          const item = (found.results || []).find(x => ['movie', 'tv'].includes(x.media_type));
          if (item) {
            tmdbData = await tmdb('/' + (item.media_type === 'tv' ? 'tv/' : 'movie/') + item.id);
            tmdbData.media_type = item.media_type;
          }
        }
      } catch (error) {
        if (!omdbData) throw error;
      }
      if (!tmdbData && !omdbData) return sendJson(req, res, 404, { error: 'Title not found by TMDB or OMDb' });
      const result = {
        title: tmdbData?.title || tmdbData?.name || omdbData?.Title || '',
        overview: tmdbData?.overview || (omdbData?.Plot && omdbData.Plot !== 'N/A' ? omdbData.Plot : ''),
        releaseDate: tmdbData?.release_date || tmdbData?.first_air_date || (omdbData?.Released !== 'N/A' ? omdbData?.Released : ''),
        posterPath: tmdbData?.poster_path || null,
        posterUrl: tmdbData?.poster_path ? 'https://image.tmdb.org/t/p/w500' + tmdbData.poster_path : (omdbData?.Poster && omdbData.Poster !== 'N/A' ? omdbData.Poster : null),
        tmdbId: tmdbData?.id || null,
        imdbId: (omdbData?.imdbID && omdbData.imdbID !== 'N/A') ? omdbData.imdbID : (imdbId || null),
        mediaType: tmdbData?.media_type || null,
        tmdbRating: Number.isFinite(tmdbData?.vote_average) ? tmdbData.vote_average : null,
        imdbRating: omdbData?.imdbRating && omdbData.imdbRating !== 'N/A' ? omdbData.imdbRating : null,
        year: omdbData?.Year || (tmdbData?.release_date || tmdbData?.first_air_date || '').slice(0, 4),
        genres: (tmdbData?.genres || []).map(g => g.name),
        runtime: tmdbData?.runtime || null,
        source: { tmdb: Boolean(tmdbData), omdb: Boolean(omdbData) },
      };
      return sendJson(req, res, 200, store(key, result));
    } catch (error) {
      const status = error.status || 502;
      return sendJson(req, res, status, { error: status === 429 ? 'Metadata provider rate limit reached' : status === 503 ? error.message : 'Metadata lookup unavailable' });
    }
  }

  return { search, title, tvmazeSearch };
}

module.exports = { createMetadataApi };
