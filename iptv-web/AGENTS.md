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
