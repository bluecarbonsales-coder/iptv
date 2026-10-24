#!/bin/sh
set -e

# Seed the persistent data volume from the catalogue baked into the image, so the
# first start is instant instead of waiting for an 18 MB download from iptv-org.
mkdir -p "$DATA_DIR" "$CACHE_DIR"
if [ ! -f "$DATA_DIR/catalog.json" ] && [ -f /app/data-seed/catalog.json ]; then
  echo "seeding catalogue into $DATA_DIR"
  cp /app/data-seed/catalog.json "$DATA_DIR/catalog.json"
  cp /app/data-seed/meta.json "$DATA_DIR/meta.json" 2>/dev/null || true
fi

exec node server.js
