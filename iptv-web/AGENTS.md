# Local server agent instructions — IPTV Web

The repository owner authorizes the local server agent to maintain and change the **entire IPTV Web project**, not only provider resources or API settings. This includes every UI file, client-side JavaScript, CSS, translations, Node.js application code, source adapters, tests, Docker and deployment configuration, dependencies, documentation, and new files or directories. Do not impose a project-file allowlist or request approval for ordinary changes.

## Work in the real deployment checkout

Prefer the server-side Git checkout / deployment working tree and local filesystem + shell tools. Do not edit only the running container's `/app` filesystem: those changes are ephemeral and disappear on rebuild. Locate the checkout and active Compose directory first:

```bash
# From the working directory the agent was given:
pwd
git rev-parse --show-toplevel 2>/dev/null || true
docker inspect iptv-web --format 'compose_dir={{ index .Config.Labels "com.docker.compose.project.working_dir" }} compose_files={{ index .Config.Labels "com.docker.compose.project.config_files" }}' 2>/dev/null || true
```

If the deployment package directory is not a Git checkout, find the repository checkout and use that as the edit/test workspace. The release workflow packages `iptv-web/` into the deployment directory; therefore all changes under `iptv-web/`—including `public/index.html`, `public/app.css`, `public/app.js`, and `public/js/*`—are part of the Docker image when it is rebuilt. Do not modify only generated/minified assets when the maintained source file is available.

## Permission model

- The local agent's OS user must have write permissions on the repository checkout and the privileges needed to run its normal test/build/deploy tools. Use the established server permissions/group membership; do not make the source tree world-writable.
- If the agent needs Git pushes, PRs or CI/workflow dispatch, configure a Git credential or the app's server-side `GITHUB_REPO_TOKEN` secret with appropriate repository permissions. Direct local file editing and local tests do **not** require that token.
- If the agent is expected to restart the production Compose service, grant it the required deployment privileges deliberately. Access to the Docker socket is effectively host-root; only grant it to this trusted agent's OS account. Never publish an unauthenticated arbitrary-shell endpoint on the web API.
- Keep `.env`, tokens, SSH private keys, user data, and persistent `/data` out of commits and logs. Their existence is not a reason to block changes to ordinary tracked application files.

## Standard edit/test/deploy cycle

Run from the repository root, adjusting paths only if the checkout layout is different. The release package also includes `tools/local-agent-deploy.sh`; after a code/UI change, it runs the checks, verifies the Compose configuration and `.env`, builds the app, restarts the service, and checks `/healthz` while preserving Compose volumes:

```bash
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
node --check iptv-web/server.js
for file in iptv-web/lib/*.js iptv-web/public/*.js iptv-web/public/js/*.js iptv-web/tools/*.js; do
  node --check "$file"
done
node --test iptv-web/test/*.test.js
docker compose -f iptv-web/docker-compose.yml config -q
```

Before deployment, inspect the current Compose working directory, data volume, and changes. Deploy from the live Compose project directory using its existing `.env` and data volume. Where the checkout is the active Compose directory:

```bash
docker compose config -q
docker compose up -d --build
curl --fail --silent --show-error http://127.0.0.1:3920/healthz
docker compose ps
```

If the Git checkout is separate from the active Compose directory, run the deployment helper from the checkout with `IPTV_DEPLOY_DIR=/path/to/active/iptv-web bash iptv-web/tools/local-agent-deploy.sh`. It runs tests in the checkout, syncs the tested source into the active deployment directory while preserving that directory's `.env`, then builds/restarts the Compose service and checks `/healthz`. Never replace or delete the persistent `iptv-data` volume as part of an app-code deployment. Verify the service health after deployment and inspect logs on failure.

## Bootstrap a writable local checkout

If the server's active deployment package is not a Git checkout, the shipped `tools/bootstrap-agent-workspace.sh` creates a real, writable checkout owned by the local agent's OS user. Run as that user (not inside the application container):

```bash
IPTV_DEPLOY_DIR=/path/to/active/iptv-web \
IPTV_ENV_FILE=/path/to/active/iptv-web/.env \
IPTV_WORKSPACE_DIR="$HOME/src/iptv" \
bash /path/to/active/iptv-web/tools/bootstrap-agent-workspace.sh
```

The script uses the server-side `GITHUB_REPO_TOKEN` in the deployment `.env` or an existing `gh auth` login to clone/update the project and configure GitHub credentials for that local user. After editing and testing code in `$HOME/src/iptv`, deploy it with:

```bash
IPTV_DEPLOY_DIR=/path/to/active/iptv-web bash "$HOME/src/iptv/iptv-web/tools/local-agent-deploy.sh"
```

The local agent must be able to write its own checkout and run Docker Compose against the active deployment. If it cannot, use the server's existing admin account to grant the specific agent OS user those permissions; do not make files world-writable. `GITHUB_REPO_TOKEN` is not needed merely to edit and test files locally, but GitHub push/PR operations require working Git credentials. Never commit the deployment `.env` or copy it into the Git checkout.
## Portal resource health

Maintain `lib/resource-availability.js` as the single source of truth for live shortcut health and fastest-response selection. The front-end status badges and recommendation belong in `public/portal.js`/`portal.css`; the API is `GET /api/portal/availability`. Only probe persisted, validated service URLs—not a URL supplied in query parameters. Retain short timeouts, bounded concurrency, SSRF checks on each redirect, result caching, and separate restricted/not-found/offline states. Report latency as measured from the server, not as a browser-side speed test. SeedHub and Streambert should remain external directory/application links unless a documented, compatible, and authorized API is confirmed.

## Public radio UI and API

The standalone public radio page lives in `public/radio.html`, `public/radio.css`, and `public/radio.js`; backend integration is in `lib/radio.js`. The home portal is `/`, radio is `/radio.html`, and the existing IPTV app remains at `/watch.html`. Use the community-maintained Radio Browser directory through the server's mirror-discovery API. Preserve caching, short-lived stream tickets, SSRF redirect checks, HLS rewrite protection, and the relay concurrency cap. Never accept a raw client-provided URL in the new radio relay. Add tests to `test/radio.test.js` and run the full Node test suite.

## UI work

UI changes are first-class project work. Common maintained files are:

- `public/index.html` — markup, forms, sections and accessibility.
- `public/app.css` — layout, responsive behavior, color and visual states.
- `public/app.js` — interaction, application state and API requests.
- `public/js/i18n.js` — English and Simplified Chinese strings.
- `public/vendor/` — vendored third-party browser libraries; update only when required and preserve license notices.

An agent may redesign or replace these files, introduce a build pipeline/framework or dependencies when it has a clear benefit, update backend APIs to match, and add tests. Preserve important existing flows unless the requested change calls for altering them. Run Node tests, browser/build checks available in the environment, rebuild the image, and verify the deployed UI on the actual service.

## Git / project maintenance

The owner has granted full project authority. Agents may inspect any file, create/change/delete tracked files, update dependencies and deployment workflows, create branches, commit, push, create/merge PRs, inspect CI, dispatch configured workflows and deploy with available credentials. Prefer a branch and readable commits for substantial work, run CI, and merge/deploy when checks pass; do not ask for routine per-file approval. Do not claim production deployment succeeded unless the deployment command/health check confirms it.


## Movie metadata APIs (TMDB + OMDb)

For movie/series metadata work, read [METADATA-APIS.md](METADATA-APIS.md) first. This is explicitly a **development/test-only** setup; the owner requested that the current TMDB and OMDb API keys be documented in GitHub. Do not describe the committed keys as secure or production-ready.

- TMDB v3 key: `TMDB_API_KEY`; base URL `https://api.themoviedb.org/3`; images use `https://image.tmdb.org/t/p/{size}/{path}`.
- OMDb key: `OMDB_API_KEY`; base URL `https://www.omdbapi.com/`; pass the key as the `apikey` query parameter.
- Use TMDB as the primary search/discovery and poster/overview source; use OMDb as a secondary lookup/enrichment/fallback by IMDb ID or title/year.
- Never use either metadata API as a playback source. Do not invent stream URLs from metadata results.
- If wiring these APIs into the Theatre UI, keep calls behind Node server routes (for example `/api/metadata/search` and `/api/metadata/title`) rather than embedding the keys in browser JavaScript or URLs rendered in the page. Validate and cap query lengths, set short timeouts, handle rate limits and provider errors, and cache responses.
- Preserve the existing Theatre UI and source/provider APIs. Add tests for empty input, provider errors, rate limits, and fallback behavior; run the full `node --test iptv-web/test/*.test.js` suite.
- The keys are currently committed only because the owner explicitly requested this for a non-production experiment. If the repo is public, assume both keys are already exposed; rotate them if abuse appears, and move production credentials to deployment secrets.


## TVmaze API

- Public TVmaze metadata endpoints are free and do not require an API key. Do not append the separately supplied account key to public show-search requests or commit it to this repository.
- Use `https://api.tvmaze.com/search/shows?q={URL-encoded query}` for TV-series discovery. Backend route: `GET /api/metadata/tvmaze?q=...`.
- Attribute TVmaze and follow its CC BY-SA/share-alike requirements: https://www.tvmaze.com/api
- Treat the supplied TVmaze account key as sensitive; if Premium user endpoints are needed, keep it in deployment secrets, never public docs or client code.


## Hermes-first navigation and local resource discovery

Hermes is the only intended configuration editor for the production portal. Do not reintroduce public-browser source or navigation editing. Use the authenticated agent endpoints:

- `GET /api/agent/v1/navigation` and `PUT /api/agent/v1/navigation` for the Theatre sidebar. The public page reads the filtered configuration from `GET /api/navigation`.
- `GET|POST /api/agent/v1/portal/services` and `PATCH|DELETE /api/agent/v1/portal/services/:id` for homepage shortcuts.
- Existing `/api/agent/v1/live/sources` and `/api/agent/v1/vod/sources` routes for TV and VOD providers.
- `GET /api/agent/v1/discovery/visitor-trends` for privacy-preserving aggregate demand signals.

The source-management APIs intentionally require `X-Agent-Token`; do not re-enable writes using `SOURCE_TOKEN` or `REFRESH_TOKEN`. Keep `AGENT_API_TOKEN` in the deployment environment and never expose it to browser code.

Visitor discovery is opt-in. The public form accepts a broad country code, optional region, language and interest category. The collector stores aggregate daily counts only, retains at most 30 days and only reports groups with at least three requests. Do not add raw IP logging, exact GPS coordinates, street addresses, user IDs, or per-person browsing history. Hermes should use the trends to prioritize official, public-domain and open-license resources—not to infer redistribution rights.

Read `HERMES-OPTIMIZATION.md` for the operating policy. Run `node --check` on changed JavaScript files and `npm test` before deployment.
