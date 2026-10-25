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

# Add maintained community IPTV playlists without replacing owner-managed sources.
# Every startup merges by URL, keeps existing records/IDs/status, and never disables
# a source. All previously saved sources are explicitly kept enabled per owner policy.
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dataDir = process.env.DATA_DIR || '/data';
const seedPath = '/app/data-seed/community-playlist-sources.json';
const registryPath = path.join(dataDir, 'sources.json');
try {
  const seeds = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  let raw;
  try { raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { raw = { sources: [] }; }
  const registry = Array.isArray(raw) ? { sources: raw } : raw;
  if (!Array.isArray(registry.sources)) registry.sources = [];
  const byUrl = new Map(registry.sources.map((s) => [s.url, s]));
  for (const seed of seeds) {
    const existing = byUrl.get(seed.url);
    if (existing) {
      existing.enabled = true;
      existing.upstreamRepository = seed.upstreamRepository;
      existing.managedBy = seed.managedBy;
      continue;
    }
    registry.sources.push({
      id: seed.id,
      name: seed.name,
      url: seed.url,
      enabled: true,
      createdAt: new Date().toISOString(),
      managedBy: seed.managedBy,
      upstreamRepository: seed.upstreamRepository
    });
    byUrl.set(seed.url, registry.sources[registry.sources.length - 1]);
  }
  for (const source of registry.sources) source.enabled = true;
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = registryPath + '.seed.tmp';
  fs.writeFileSync(temp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, registryPath);
  console.log('Community playlist source sync: ' + seeds.length + ' managed sources; ' + registry.sources.length + ' total sources enabled.');
} catch (err) {
  console.error('Community playlist source sync failed; continuing without modifying source data:', err.message);
}
NODE

exec node server.js
