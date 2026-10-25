# Persistent media library

The portal now maintains a server-side media index at \`DATA_DIR/media-library.json\` (default: \`iptv-web/data/media-library.json\`). The file is created on first saved discovery/import, written atomically with restrictive file permissions, and is not part of the source tree. Keep the configured data directory on persistent storage when deploying.

The existing live iptv-org catalog remains in \`catalog.json\` and keeps its current in-memory search index. \`/library.html\` searches both that live catalog and the persistent VOD/import index.

## Endpoints

- \`GET /api/library?q=&type=&page=&limit=\` — public, paginated unified search. Supported types: \`all\`, \`channel\`, \`movies\`, \`series\`, \`anime\`, \`documentary\`, \`video\`.
- \`GET /api/library/stats\` — counts for saved media records.
- \`POST /api/library/items\` — authenticated upsert of one item or an \`items\` array.
- \`DELETE /api/library/items/:id\` — authenticated removal of a saved record.
- \`POST /api/library/import-m3u\` — authenticated JSON body \`{ "name": "My playlist", "url": "https://example.org/list.m3u" }\`; imports up to 25,000 HTTP(S) entries.
- \`POST /api/library/sync\` — authenticated synchronization of the first configured pages from enabled VOD providers. Defaults to three pages per provider; tune with \`MEDIA_LIBRARY_SYNC_PAGES\` (1–10) and rerun to continue refreshing.

Write endpoints require \`X-Agent-Token\` matching \`AGENT_API_TOKEN\`, consistent with the existing source-management APIs. Never expose that token in browser JavaScript.

## Important behavior

- Search discoveries are saved automatically; provider searches do not imply that every provider's full catalog has been indexed.
- \`POST /api/library/sync\` is an explicit, bounded operation, not an unlimited crawler. Providers with large catalogs may require additional pages or a provider-specific pagination job.
- Source URLs are retained server-side for administration/playback, but the public library search response omits playback and detail URLs.
- Deleting a library entry removes that indexed record only; it does not delete its source or underlying media.
- Use sources you are authorized to access. API compatibility and reachability checks do not establish distribution rights.
- Back up \`DATA_DIR\` before deployment changes. Do not store the data directory in a disposable build/container layer.
