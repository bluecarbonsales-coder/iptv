# TMDB + OMDb metadata APIs

> **Development/test only — not production configuration.** The repository owner explicitly requested that the current keys be present in GitHub for this experiment. The repository is public, so anyone can copy these keys and consume their quotas. Free access does not mean unlimited usage or unrestricted commercial rights.

## Configured providers

| Provider | Purpose | Base URL | Environment variable |
|---|---|---|---|
| TMDB | Search/discovery, movie and TV details, posters, overviews, ratings and release metadata | `https://api.themoviedb.org/3` | `TMDB_API_KEY` |
| OMDb | Secondary title details and IMDb-ID lookup; useful for IMDb ratings and cross-checking metadata | `https://www.omdbapi.com/` | `OMDB_API_KEY` |
| TVmaze | TV-show search, show details, episodes, cast and schedules | `https://api.tvmaze.com` | No key required for public API |

## Current development keys

These values are committed at the owner's explicit request for a non-production experiment:

- `TMDB_API_KEY=521e53596957b410b3e69b5eefb5cb00`
- `OMDB_API_KEY=dfa677fa`

The same development values are listed in `iptv-web/.env.example`. Treat them as public, rate-limited test credentials—not secrets and not production configuration. Never put other credentials (GitHub tokens, agent tokens, email passwords, or deployment secrets) in this file.

## TVmaze public API (no key required)

Show search:

```http
GET https://api.tvmaze.com/search/shows?q=The%20Office
```

The application exposes this through `GET /api/metadata/tvmaze?q=The%20Office`. Credit TVmaze with a visible link and comply with its CC BY-SA/share-alike licensing terms.

The separately supplied TVmaze account key is not committed here. Public metadata requests do not need it; treat it as sensitive and store it only in deployment secrets if you verify a need for Premium user endpoints.

## Request examples

TMDB search:

```http
GET https://api.themoviedb.org/3/search/multi?query=Interstellar&api_key=$TMDB_API_KEY
```

TMDB movie details:

```http
GET https://api.themoviedb.org/3/movie/157336?api_key=$TMDB_API_KEY
```

OMDb title lookup:

```http
GET https://www.omdbapi.com/?t=Interstellar&apikey=$OMDB_API_KEY
```

OMDb IMDb-ID lookup:

```http
GET https://www.omdbapi.com/?i=tt0816692&apikey=$OMDB_API_KEY
```

Use URL encoding for all user-supplied search terms. Do not log full request URLs because they contain API keys.

## Integration guidance for coding agents

1. Read `iptv-web/AGENTS.md` and preserve the current Theatre page and player behavior.
2. Keep provider requests on the Node server, not in browser JavaScript. Add narrow routes such as:
   - `GET /api/metadata/search?q=...` — use TMDB multi-search as the primary search provider.
   - `GET /api/metadata/title?id=...` or `?imdbId=...` — fetch TMDB details and optionally enrich with OMDb.
3. Load `TMDB_API_KEY` and `OMDB_API_KEY` from the process environment. Never return keys to the browser, include them in HTML, or log request URLs.
4. Validate query length and allowed identifiers, use HTTPS, short request timeouts, bounded response sizes, caching, and graceful handling for HTTP 401/403/429/5xx and malformed JSON.
5. Use TMDB for poster paths via `https://image.tmdb.org/t/p/w500/{poster_path}`; handle missing poster paths cleanly. OMDb poster URLs may be absent or `N/A`.
6. Keep metadata separate from stream providers: search results and title records do not establish that a stream exists or that playback/redistribution is authorized.
7. Add focused tests for validation, successful responses, missing results, rate limits, provider failures and OMDb fallback; run `node --test iptv-web/test/*.test.js` and the project's normal checks.
8. Review the providers' current terms, attribution requirements, quotas, and commercial-use rules before any public or commercial launch.

## Official documentation

- TVmaze API: https://www.tvmaze.com/api
- TMDB API: https://developer.themoviedb.org/docs
- TMDB FAQ and commercial-use guidance: https://developer.themoviedb.org/docs/faq
- OMDb API and key page: https://www.omdbapi.com/
