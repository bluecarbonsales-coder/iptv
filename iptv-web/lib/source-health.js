'use strict';
const fs = require('fs');
const path = require('path');
const { upstreamFetch } = require('./fetch-upstream');
const TYPES = ['radio', 'iptv', 'theatre'];
const DEFAULT_REFRESH_MS = 60000, FORCE_COOLDOWN_MS = 15000, REQUEST_TIMEOUT_MS = 2500, SLOW_THRESHOLD_MS = 1500, MAX_CHECKS = 800, HISTORY_LIMIT = 24;
function isHttpUrl(raw) {
  try { const u = new URL(String(raw || '')); return ['http:', 'https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password; }
  catch { return false; }
}
function classify(statusCode, latencyMs) {
  if (statusCode >= 200 && statusCode < 400) return { status: latencyMs >= SLOW_THRESHOLD_MS ? 'slow' : 'online', available: true, reason: '' };
  if ([401, 403, 429].includes(statusCode)) return { status: 'restricted', available: false, reason: statusCode === 429 ? 'rate_limited' : 'access_restricted' };
  if ([404, 410].includes(statusCode)) return { status: 'not_found', available: false, reason: 'resource_not_found' };
  if (statusCode >= 500) return { status: 'offline', available: false, reason: 'upstream_error' };
  return { status: 'unavailable', available: false, reason: 'unexpected_http_status' };
}
async function mapLimit(items, limit, fn) {
  let cursor = 0; async function worker() { while (true) { const i = cursor++; if (i >= items.length) return; await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
function createSourceHealth(options = {}) {
  if (typeof options.getSources !== 'function') throw new TypeError('getSources must be a function');
  const fetchUpstream = options.upstreamFetch || upstreamFetch, now = options.now || Date.now;
  const refreshMs = Number.isFinite(options.refreshMs) ? Math.max(15000, options.refreshMs) : DEFAULT_REFRESH_MS;
  const cooldown = Number.isFinite(options.forceCooldownMs) ? Math.max(0, options.forceCooldownMs) : FORCE_COOLDOWN_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(500, options.timeoutMs) : REQUEST_TIMEOUT_MS;
  const concurrency = Number.isFinite(options.concurrency) ? Math.max(1, Math.min(16, options.concurrency)) : 12;
  const historyFile = options.historyFile || (options.dataDir ? path.join(options.dataDir, 'source-health-history.json') : null);
  const statuses = new Map(), history = new Map();
  let scanStartedAt = 0, scanCompletedAt = 0, scanPromise = null;

  if (historyFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      for (const [key, entries] of Object.entries(stored || {})) {
        if (!Array.isArray(entries)) continue;
        history.set(key, entries.filter(entry => entry && typeof entry.checkedAt === 'string' &&
          typeof entry.available === 'boolean').slice(-HISTORY_LIMIT).map(entry => ({
          checkedAt: entry.checkedAt, available: entry.available,
          latencyMs: Number.isFinite(entry.latencyMs) ? entry.latencyMs : null,
          status: String(entry.status || (entry.available ? 'online' : 'offline')),
        })));
      }
    } catch {}
  }
  function persistHistory() {
    if (!historyFile) return;
    try {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      const data = Object.fromEntries(history);
      const temp = historyFile + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, historyFile);
    } catch {}
  }
  function recordHistory(key, result) {
    if (typeof result.available !== 'boolean') return;
    const entries = history.get(key) || [];
    entries.push({ checkedAt: result.checkedAt, available: result.available,
      latencyMs: Number.isFinite(result.proxyLatencyMs) ? result.proxyLatencyMs : null, status: result.status });
    history.set(key, entries.slice(-HISTORY_LIMIT));
  }
  function historyMetrics(key) {
    const entries = history.get(key) || [];
    const latencies = entries.map(entry => entry.latencyMs).filter(Number.isFinite);
    return {
      historySamples: entries.length,
      uptimePercent: entries.length ? Math.round(100 * entries.filter(entry => entry.available).length / entries.length) : null,
      averageLatencyMs: latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null,
      recentHistory: entries.map(entry => entry.available),
    };
  }
  function listSources() {
    const groups = options.getSources() || {};
    return TYPES.flatMap(type => (Array.isArray(groups[type]) ? groups[type] : []).map(s => ({
      id: String(s.id || ''), name: String(s.name || 'Unnamed source'), type, enabled: s.enabled !== false, url: String(s.url || s.api || '').trim()
    }))).filter(s => s.id).slice(0, MAX_CHECKS);
  }
  async function probe(source) {
    const base = { id: source.id, type: source.type, name: source.name, checkedAt: new Date(now()).toISOString() };
    if (!source.enabled) return { ...base, status: 'disabled', available: null, proxyLatencyMs: null, latencyMs: null, httpStatus: null, reason: 'disabled' };
    if (!isHttpUrl(source.url)) return { ...base, status: 'unknown', available: false, proxyLatencyMs: null, latencyMs: null, httpStatus: null, reason: 'unsupported_url' };
    const started = now(); let response = null, lastError = null;
    for (const method of ['HEAD', 'GET']) {
      try {
        const result = await fetchUpstream(source.url, { method, timeoutMs, maxRedirects: 4, range: method === 'GET' ? 'bytes=0-0' : null,
          userAgent: 'IPTV-Web-Source-Health/1.0', extraHeaders: { Accept: '*/*' }, cookies: false });
        response = result.response;
        if (method === 'HEAD' && [400, 401, 403, 405, 501].includes(response.status)) { try { await response.body?.cancel(); } catch {} response = null; continue; }
        break;
      } catch (error) { lastError = error; if (method === 'HEAD' && error && error.statusCode === 405) continue; break; }
    }
    const latency = Math.max(0, Math.round(now() - started));
    if (!response) {
      const msg = String(lastError && lastError.message || '').toLowerCase();
      const reason = msg.includes('timeout') || msg.includes('abort') ? 'timeout' : msg.includes('dns') ? 'dns_error' : 'network_error';
      return { ...base, status: 'offline', available: false, proxyLatencyMs: latency, latencyMs: latency, httpStatus: null, reason };
    }
    try { await response.body?.cancel(); } catch {}
    const result = classify(response.status, latency);
    return { ...base, ...result, proxyLatencyMs: latency, latencyMs: latency, httpStatus: response.status, reason: result.reason };
  }
  async function runScan() {
    const sources = listSources(), keys = new Set(sources.map(s => s.type + ':' + s.id));
    for (const key of statuses.keys()) if (!keys.has(key)) statuses.delete(key);
    for (const key of history.keys()) if (!keys.has(key)) history.delete(key);
    await mapLimit(sources, concurrency, async source => {
      const key = source.type + ':' + source.id;
      const result = await probe(source);
      statuses.set(key, result);
      if (source.enabled) recordHistory(key, result);
    });
    persistHistory();
  }
  function startScan(force = false) {
    if (scanPromise) return scanPromise;
    const current = now();
    if (!force && scanStartedAt && current - scanStartedAt < refreshMs) return Promise.resolve(false);
    if (force && scanStartedAt && current - scanStartedAt < cooldown) return Promise.resolve(false);
    scanStartedAt = current; scanCompletedAt = 0;
    scanPromise = runScan().then(() => { scanCompletedAt = now(); return true; }).finally(() => { scanPromise = null; });
    return scanPromise;
  }
  function getSnapshot() {
    const snapshot = listSources().map(s => {
      const key = s.type + ':' + s.id, previous = statuses.get(key), metrics = historyMetrics(key);
      if (!s.enabled) return { id: s.id, type: s.type, name: s.name, status: 'disabled', available: null, proxyLatencyMs: null, latencyMs: null, httpStatus: null, checkedAt: previous && previous.checkedAt || null, reason: 'disabled', ...metrics };
      return { ...(previous || { id: s.id, type: s.type, name: s.name, status: 'checking', available: null, proxyLatencyMs: null, latencyMs: null, httpStatus: null, checkedAt: null, reason: '' }), ...metrics };
    });
    const summary = {};
    for (const type of TYPES) {
      const group = snapshot.filter(s => s.type === type), enabled = group.filter(s => s.status !== 'disabled');
      summary[type] = { total: group.length, enabled: enabled.length, available: enabled.filter(s => s.available === true).length,
        unavailable: enabled.filter(s => s.status !== 'checking' && s.available !== true).length,
        checking: enabled.filter(s => s.status === 'checking').length, disabled: group.filter(s => s.status === 'disabled').length };
    }
    summary.all = TYPES.reduce((total, type) => { for (const k of ['total','enabled','available','unavailable','checking','disabled']) total[k] += summary[type][k]; return total; }, { total: 0, enabled: 0, available: 0, unavailable: 0, checking: 0, disabled: 0 });
    return { statuses: snapshot, summary, scanning: !!scanPromise, scanStartedAt: scanStartedAt ? new Date(scanStartedAt).toISOString() : null,
      scanCompletedAt: scanCompletedAt ? new Date(scanCompletedAt).toISOString() : null, refreshEveryMs: refreshMs,
      historyLimit: HISTORY_LIMIT, latencySource: 'server-to-source HTTP check; not stream throughput' };
  }
  return { startScan, getSnapshot };
}
module.exports = { createSourceHealth, isHttpUrl, classify };
