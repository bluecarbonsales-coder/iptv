# Hermes-first IPTV Web operations

## Configuration ownership

Hermes is the sole intended configuration editor for the production portal. Use the authenticated `/api/agent/v1/*` API for source registry changes and the navigation API for menu changes. Do not expose the agent token to browser JavaScript, visitor pages, prompts, or URLs. Public routes should remain read-only. Keep a before/after audit trail for configuration changes and validate all URLs before activation.

The project already has agent-only authenticated endpoints for live sources, VOD providers, scheduled source maintenance, audit history, and repository changes. The Theatre sidebar was originally hard-coded; it should be treated as a managed configuration and loaded from `GET /api/navigation`, with updates restricted to `PUT /api/agent/v1/navigation`.

## Visitor-assisted resource discovery

Use visitor context only after an explicit opt-in. Prefer coarse country, optional broad region, language, and the visitor's selected resource category. The browser may offer a geolocation prompt, but should not call it automatically. If geolocation is used, reduce coordinates to a broad region in the browser and discard the coordinates before sending anything to the server. Never store raw IP addresses, exact coordinates, account identifiers, search terms tied to a person, or full browsing history for this feature.

The resource-trend collector stores only daily aggregate counters for country/region/language/category combinations, retains at most 30 days, and exposes only groups with at least three requests. Hermes can read these trends through an authenticated agent endpoint and use them to prioritize external searches for public radio, official broadcaster pages, public-domain media, local culture/education resources, and other legally accessible sources. Trends are signals for discovery, not permission to collect or redistribute media.

## Search and source safety

- Prefer official, public, open-license, public-domain, and provider-documented APIs.
- Metadata services such as TMDB, OMDb and TVmaze enrich titles; they are not playback sources.
- Never treat a source's successful API probe as evidence of content rights.
- Validate every URL and redirect against SSRF/private-network protections. Use timeouts, bounded concurrency, response-size limits, caching and rate limits.
- Keep source endpoints disabled until Hermes has checked compatibility and documented the source's origin and intended use.
- Do not store media files on the server unless explicitly requested; playback should remain remote/direct or use the existing optional relay.
- Keep credentials in deployment secrets. Public repository API keys are not private and should be rotated if abused.

## Hermes deployment checklist

1. Read `/api/agent/v1/openapi.json` and `/api/agent/v1/capabilities`.
2. Read status and audit records before changes.
3. Change navigation and source registries through the agent API; use repository edits only when the runtime API cannot express the desired change.
4. Run `node --check`, `npm test`, and `docker compose config -q` before deployment.
5. Preserve the existing persistent data volume and environment file; confirm `/healthz` after deployment.
6. Report what changed, validation results, and any unverified external source.
