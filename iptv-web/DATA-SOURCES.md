# Media source guide

This project separates **streaming providers**, **publicly licensed video**, and **metadata APIs**. They are not interchangeable.

## Built-in source: Internet Archive

The VOD search endpoint queries the Internet Archive Advanced Search API and resolves items through its metadata API:

- Advanced Search API: https://archive.org/advancedsearch.php
- Item metadata API: https://archive.org/metadata/
- Developer documentation: https://archivesupport.zendesk.com/hc/en-us/articles/360001495812-Developer-Resources
- Query/API notes: https://doc-tools.readthedocs.io/en/ia-test-gsod/item-search-apis.html

The adapter is built in, needs no API key, and does not require adding a provider manually. It only displays archive records when metadata declares public-domain status or a compatible Creative Commons license; non-commercial CC licenses are excluded. It chooses browser-compatible MP4/WebM/Ogg video files when available. It presents the Archive item page so users can inspect the underlying record.

This is a best-effort metadata filter, **not a legal guarantee**. The uploader's declaration, territorial rules, privacy/publicity rights, and Archive policies can still matter. Check the item's own record before redistributing or embedding it in a commercial service.

Open-source examples that demonstrate this pattern include:
- https://github.com/amponce/archive-movie-browser — Internet Archive video plus TMDB metadata, with an MCP server for agent-assisted finding. We use the source/API idea, not their branded interface or copied code.
- https://github.com/noknows08/free-stream — a small Internet Archive public-domain/Creative Commons movie browser.

## Built-in source: Wikimedia Commons

The app also queries Wikimedia Commons' MediaWiki Action API using `generator=search` plus `imageinfo` URL and `extmetadata` fields. It only returns direct browser-compatible video files whose machine-readable record declares CC0, Public Domain, CC BY, or CC BY-SA metadata; CC non-commercial variants and unknown licenses are filtered out. Results link to the original Commons file page and include attribution data where available.

- Machine-readable file metadata: https://commons.wikimedia.org/wiki/Commons:Machine-readable_data/en
- API access policy and license guidance: https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy

Commons has short films, animations, educational videos, and other freely licensed media, but it is not a complete feature-film or anime catalog. As with Archive metadata, the uploader-provided licensing fields are a discovery filter rather than a legal guarantee.

## Provider directories supported by import

A provider directory is a JSON list of endpoints. It does not itself host the content or verify the rights to every URL.

- LibreTV project: https://github.com/LibreSpark/LibreTV — supports SourceList-style `sources[]` config.
- MoonTV project: https://github.com/Stardm0/MoonTV — supports a `config.json`-style `api_site{}` structure where endpoints are compatible.
- TVBox-style directories — supports `sites[]` records whose `api` points to compatible Apple CMS/MacCMS APIs.

You can upload a downloaded JSON config in the VOD manager, send a JSON object to the agent API, or set `VOD_SOURCE_LIST_URLS` to a small list of registry URLs you reviewed. The scheduler polls only those explicitly configured URLs. In `AGENT_AUTONOMY=full` mode it probes new endpoints before enabling them and can update the endpoint of a provider originally imported from that same registry. This probe checks API compatibility—not copyright ownership or reliability of every stream.

Do not put random source lists into `VOD_SOURCE_LIST_URLS`. Provider endpoint lists can change owners, domains, content, and rights without notice.

## Other sources worth considering

| Source | What it provides | Integration status / notes |
|---|---|---|
| Internet Archive | Searchable media files, item metadata, public-domain and CC items | **Built in**; no key. The adapter filters by declared license metadata. |
| Wikimedia Commons | Direct video files with machine-readable license and attribution metadata | **Built in**; CC0 / Public Domain / CC BY / CC BY-SA filtering plus original file-page links. Not a comprehensive feature-film catalog. https://commons.wikimedia.org/wiki/Commons:Licensing |
| TMDB | Movie/series metadata, posters, synopses | Metadata only—not playback URLs. Its developer API is free for non-commercial use with attribution; commercial use requires a separate license. https://developer.themoviedb.org/docs/faq |
| AniList / Kitsu | Anime catalog metadata | Metadata only—not legal video streams. They can be added for better search, season/episode metadata, and links, but should not be treated as streaming providers. |
| Official broadcaster or studio APIs | Authorized live/VOD catalogs, where public APIs exist | Add only when the provider permits this use and its playback rights cover your deployment. |

There is no general public license that makes every commercial film or anime episode free to redistribute. For commercial anime and recent films, use authorized providers; for no-cost unrestricted items, prioritize public-domain or permissively licensed collections.

## Agent automation

See [AGENTS.md](../AGENTS.md) for an actionable Hermes playbook and [the agent OpenAPI endpoint](/api/agent/v1/openapi.json) after deployment. It describes capabilities, full authenticated agent writes, mutable runtime settings, scheduled source sync, provider health checks, maintenance tasks, open-license search, and an audit log.
