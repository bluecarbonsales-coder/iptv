'use strict';
const fs = require('fs');
const path = require('path');
const LIMIT = 24;

function createSourceHealthHistory(dataDir) {
  const file = path.join(dataDir, 'source-health-history.json');
  const history = new Map();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, entries] of Object.entries(stored || {})) {
      if (!Array.isArray(entries)) continue;
      history.set(key, entries.filter(x => x && typeof x.checkedAt === 'string' && typeof x.available === 'boolean').slice(-LIMIT));
    }
  } catch {}

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(history)), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {}
  }
  function record(key, result) {
    if (typeof result.available !== 'boolean') return;
    const entries = history.get(key) || [];
    entries.push({
      checkedAt: result.checkedAt,
      available: result.available,
      latencyMs: Number.isFinite(result.proxyLatencyMs) ? result.proxyLatencyMs : null,
      status: String(result.status || 'unknown'),
    });
    history.set(key, entries.slice(-LIMIT));
    persist();
  }
  function metrics(key) {
    const entries = history.get(key) || [];
    const latencies = entries.map(x => x.latencyMs).filter(Number.isFinite);
    return {
      historySamples: entries.length,
      uptimePercent: entries.length ? Math.round(100 * entries.filter(x => x.available).length / entries.length) : null,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
      recentHistory: entries.map(x => x.available),
    };
  }
  function prune(keys) {
    for (const key of history.keys()) if (!keys.has(key)) history.delete(key);
    persist();
  }
  return { record, metrics, prune, limit: LIMIT };
}
module.exports = { createSourceHealthHistory };
