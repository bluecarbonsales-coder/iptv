# Community IPTV playlist sources

The portal seeds the following community-maintained playlist URLs into the persistent live-source registry at container startup:

| Source | Upstream | Refresh behavior |
|---|---|---|
| Collect-IPTV | https://github.com/zilong7728/Collect-IPTV | Reads the project's generated `best_sorted.m3u`; upstream says its playlist is regenerated every four hours. |
| fanmingming/live | https://github.com/fanmingming/live | Reads `tv/m3u/ipv6.m3u` directly from the repository's default branch. |
| Tvlist-awesome-m3u-m3u8 | https://github.com/imDazui/Tvlist-awesome-m3u-m3u8 | Reads the published mobile IPv6 M3U file from the repository. |
| awesome-zhuiju-free | https://github.com/laoma528/awesome-zhuiju-free | Reads the VMA playlist URL listed in the project's `resources/resources.json`; the rest of that repository is a curated resource directory, not itself a single playable playlist. |

## Non-destructive behavior

- The registry is merged by playlist URL; existing owner-managed source records and IDs are retained.
- Community entries are enabled on startup, and existing source entries are also left enabled. This project policy must not silently disable sources.
- Playlist contents are fetched again during the normal catalogue refresh; the URLs are not copied into a static local snapshot.
- A failed fetch is recorded as a source error. The source remains enabled and the last-known-good channels are retained where available.
- The source list is seeded from `data/community-playlist-sources.json` into the persistent `DATA_DIR/sources.json` volume. Existing custom sources are not deleted.
- A source being enabled does not guarantee every channel is reachable, compatible with the user's network, or authorized for redistribution. Check the source's terms and local law.

To change community defaults, edit `data/community-playlist-sources.json`. The entrypoint re-merges the defaults at every container start; the normal live playlist refresh fetches the latest content from the upstream URLs.


## Optional music search and downloader

The media stack includes a separate `music-dl` service using the upstream
[go-music-dl](https://github.com/guohuiyuan/go-music-dl) container image. It is
linked into Theatre at `/music/` through the internal Docker network proxy;
the service itself is published only on host loopback (`127.0.0.1:8081`) and
uses its own named `music-data` volume. The service is independent of the IPTV
playlist and VOD catalogues. Preserve `music-data` across upgrades.

Use this tool only for music you are authorized to access and download. Upstream
music platform availability and download permissions vary by source and region.
