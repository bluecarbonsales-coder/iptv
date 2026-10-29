# Self-hosted Go Music DL integration

Go Music DL runs as its own Docker service on the same private Docker network as `iptv-web`. The existing IPTV Node server reverse-proxies `/music` to the service. No extra public host port is exposed.

## Install / update on the VPS

From the repository checkout at `/home/harry/iptv`:

```bash
git pull origin main
sh iptv-web/deploy/install-music-dl.sh
docker logs --tail 100 music-dl
```

The installer detects the running `iptv-web` container and its Docker network, pulls `guohuiyuan/go-music-dl:latest`, and starts the service with `--base-path /music`. Persistent settings, cookies, playlists and downloads live in `/home/harry/iptv/data/music-dl`.

Then rebuild/restart IPTV Web so the latest Music Studio wrapper and reverse-proxy code are active:

```bash
docker compose up -d --build iptv-web
```

Open `https://YOUR-EXISTING-IPTV-HOST/music.html`. The app is also available at `/music/` on the same host. It is intentionally not bound to a public host port; access it through the existing reverse proxy.

## First-run admin setup

Search, preview and browsing are available without an account. To configure platform cookies or settings, inspect the startup logs for the one-time Web setup token and follow Go Music DL's first-run setup page. Keep the token and resulting credentials private.

## Troubleshooting

- `docker ps --filter name=music-dl`
- `docker logs --tail 150 music-dl`
- `docker inspect iptv-web --format '{{json .NetworkSettings.Networks}}'` (replace the container name if Compose chose a generated name)
- If your web container has a different name, run `IPTV_WEB_CONTAINER=actual-container-name sh iptv-web/deploy/install-music-dl.sh`.

The upstream project is licensed under AGPL-3.0. Review its licence and the rights of any downloaded content: https://github.com/guohuiyuan/go-music-dl
