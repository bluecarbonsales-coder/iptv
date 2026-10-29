#!/bin/sh
set -eu

# Install Go Music DL beside the existing IPTV Web container, on its Docker network.
# The Node app proxies /music/* to the service, so no extra public host port is opened.
CONTAINER_NAME="music-dl"
IMAGE="guohuiyuan/go-music-dl:latest"
DATA_DIR="${MUSIC_DL_DATA_DIR:-/home/harry/iptv/data/music-dl}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required." >&2
  exit 1
fi

WEB_CONTAINER="${IPTV_WEB_CONTAINER:-}"
if [ -z "$WEB_CONTAINER" ]; then
  WEB_CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=iptv-web' --format '{{.Names}}' | head -n 1)"
fi
if [ -z "$WEB_CONTAINER" ]; then
  WEB_CONTAINER="$(docker ps --filter 'name=iptv-web' --format '{{.Names}}' | head -n 1)"
fi
if [ -z "$WEB_CONTAINER" ]; then
  echo "ERROR: Could not find the running iptv-web container. Start IPTV Web first, or set IPTV_WEB_CONTAINER." >&2
  exit 1
fi

NETWORK="$(docker inspect "$WEB_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n 1 | tr -d '\r')"
if [ -z "$NETWORK" ]; then
  echo "ERROR: Could not determine the Docker network for $WEB_CONTAINER." >&2
  exit 1
fi

echo "Using IPTV container: $WEB_CONTAINER"
echo "Using Docker network: $NETWORK"
echo "Persistent music data: $DATA_DIR"

docker pull "$IMAGE"
mkdir -p "$DATA_DIR"
if command -v chown >/dev/null 2>&1; then chown -R 1000:1000 "$DATA_DIR" 2>/dev/null || true; fi

# Recreate only after the replacement image has downloaded successfully.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --network-alias music-dl \
  --volume "$DATA_DIR:/home/appuser/data" \
  --env TZ=Asia/Tokyo \
  "$IMAGE" ./music-dl web --port 8080 --no-browser --base-path /music

echo
echo "Go Music DL has been started."
echo "Open it through the existing IPTV site at /music/ (no extra public port exposed)."
echo "Check startup/admin setup token with: docker logs --tail 100 $CONTAINER_NAME"
