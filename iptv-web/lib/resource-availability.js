'use strict';

// Bounded HTTP reachability monitor for configured service-portal links.
// It never accepts target URLs from a request: targets come from the already-validated
// persistent portal directory. Every request and redirect goes through upstreamFetch's SSRF guard.
const { upstreamFetch } = require('./fetch-upstream');
const { sendJson } = require('./util');

const DEFAULT_REFRESH_MS = 60_000;
const FORCE_COOLDOWN_MS = 15_000;
const REQUEST_TIMEOUT_MS = 4_500;
const SLOW_THRESHOLD_MS = 1_500;
const MAX_CHECKS = 200;

function isHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function classify(statusCode, latencyMs, checkedAt) {
  let status;
  let available = false;
  let reason = '';
  if (statusCode >= 200 && statusCode < 400) {
    available = true;
    status = latencyMs >= SLOW_THRESHOLD_MS ? 'slow' : 'online';
  } else if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
    status = 'restricted';
    reason = statusCode === 429 ? 'rate_limited' : 'access_restricted';
  } else if (statusCode === 404 || statusCode === 410) {
    status = 'not_found';
    reason = 'resource_not_found';
  } else if (statusCode >= 500) {
    status = 'offline';
    reason = 'upstream_error';
  } else {
    status = 'unavailable';
    reason = 'unexpected_http_status';
  }
  return { status, available, latencyMs, httpStatus: statusCode, checkedAt, reason };
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function createResourceAvailability(options = {}) {
  const getServices = options.getServices;
  if (typeof getServices !== 'function') throw new TypeError('getServices must be a function');
  const fetchUpstream = options.upstreamFetch || upstreamFetch;
  const now = options.now || Date.now;
  const refreshMs = Number.isFinite(options.refreshMs) ? Math.max(15_000, options.refreshMs) : DEFAULT_REFRESH_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(500, options.timeoutMs) : REQUEST_TIMEOUT_MS;
  const concurrency = Number.isFinite(options.concurrency) ? Math.max(1, Math.min(12, options.concurrency)) : 8;
  const statuses = new Map();
  let scanStartedAt = 0;
  let scanCompletedAt = 0;
  let scanPromise = null;

  function localStatus(checkedAt) {
    return { status: 'local', available: true, latencyMs: null, httpStatus: null, checkedAt, reason: 'same_application' };
  }

  async function probeService(service) {
    const checkedAt = new Date(now()).toISOString();
    const rawUrl = String(service.url || '').trim();
    if (rawUrl.startsWith('/') && !rawUrl.startsWith('//')) return { id: service.id, ...localStatus(checkedAt) };
    if (!isHttpUrl(rawUrl)) return { id: service.id, status: 'unknown', available: false, latencyMs: null, httpStatus: null, checkedAt, reason: 'unsupported_url' };

    const startedAt = now();
    let response = null;
    let lastError = null;
    for (const method of ['HEAD', 'GET']) {
      try {
        const result = await fetchUpstream(rawUrl, {
          method,
          timeoutMs,
          maxRedirects: 4,
          range: method === 'GET' ? 'bytes=0-0' : null,
          userAgent: 'IPTV-Web-Resource-Health/1.0',
          extraHeaders: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
          cookies: false,
        });
        response = result.response;
        if (method === 'HEAD' && [400, 401, 403, 405, 501].includes(response.status)) {
          try { await response.body?.cancel(); } catch {}
          response = null;
          continue;
        }
        break;
      } catch (err) {
        lastError = err;
        if (method === 'HEAD' && err && err.statusCode === 405) continue;
        break;
      }
    }

    const latencyMs = Math.max(0, Math.round(now() - startedAt));
    if (!response) {
      const message = String(lastError && lastError.message || '').toLowerCase();
      const reason = message.includes('timeout') || message.includes('abort') ? 'timeout'
        : message.includes('dns') ? 'dns_error'
          : 'network_error';
      return {
        id: service.id,
        status: 'offline',
        available: false,
        latencyMs,
        httpStatus: null,
        checkedAt: new Date(now()).toISOString(),
        reason,
      };
    }

    const result = { id: service.id, ...classify(response.status, latencyMs, new Date(now()).toISOString()) };
    try { await response.body?.cancel(); } catch {}
    return result;
  }

  async function runScan() {
    const listed = await getServices();
    const services = (Array.isArray(listed) ? listed : []).slice(0, MAX_CHECKS);
    const currentIds = new Set(services.map((service) => String(service.id)));
    for (const id of statuses.keys()) if (!currentIds.has(id)) statuses.delete(id);

    const results = await mapLimit(services, concurrency, async (service) => {
      try {
        return await probeService(service);
      } catch {
        return {
          id: String(service.id),
          status: 'offline',
          available: false,
          latencyMs: null,
          httpStatus: null,
          checkedAt: new Date(now()).toISOString(),
          reason: 'probe_error',
        };
      }
    });
    for (const result of results) statuses.set(String(result.id), result);
  }

  function startScan(force = false) {
    if (scanPromise) return scanPromise;
    const timestamp = now();
    if (force && timestamp - scanStartedAt < FORCE_COOLDOWN_MS) return Promise.resolve(false);
    if (!force && timestamp - scanStartedAt < refreshMs) return Promise.resolve(false);

    scanStartedAt = timestamp;
    scanPromise = runScan()
      .then(() => { scanCompletedAt = now(); return true; })
      .finally(() => { scanPromise = null; });
    return scanPromise;
  }

  function getSnapshot() {
    const listed = getServices();
    const services = (Array.isArray(listed) ? listed : []).slice(0, MAX_CHECKS);
    const checkedAt = new Date(now()).toISOString();
    const items = services.map((service) => {
      const cached = statuses.get(String(service.id));
      if (cached) return { ...cached };
      if (String(service.url || '').startsWith('/') && !String(service.url || '').startsWith('//')) {
        return { id: String(service.id), ...localStatus(checkedAt) };
      }
      return {
        id: String(service.id),
        status: 'checking',
        available: null,
        latencyMs: null,
        httpStatus: null,
        checkedAt: null,
        reason: '',
      };
    });

    const byId = new Map(services.map((service) => [String(service.id), service]));
    const fastestItem = items
      .filter((item) => {
        const service = byId.get(String(item.id));
        return service && String(service.category || '').toLowerCase() === 'media resources'
          && (item.status === 'online' || item.status === 'slow')
          && Number.isFinite(item.latencyMs);
      })
      .sort((a, b) => a.latencyMs - b.latencyMs)[0];
    const fastestService = fastestItem && byId.get(String(fastestItem.id));
    return {
      statuses: items,
      fastest: fastestItem && fastestService ? {
        id: String(fastestItem.id),
        name: String(fastestService.name || fastestItem.id),
        url: String(fastestService.url || ''),
        latencyMs: fastestItem.latencyMs,
        httpStatus: fastestItem.httpStatus,
        checkedAt: fastestItem.checkedAt,
      } : null,
      scanning: Boolean(scanPromise),
      scanStartedAt: scanStartedAt ? new Date(scanStartedAt).toISOString() : null,
      scanCompletedAt: scanCompletedAt ? new Date(scanCompletedAt).toISOString() : null,
      refreshEveryMs: refreshMs,
      measuredFrom: 'application-server',
    };
  }

  async function handler(req, res) {
    try {
      const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
      startScan(force).catch(() => {});
      // Return cached measurements immediately; the browser polls while a fresh check is running.
      sendJson(req, res, 200, getSnapshot());
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || 'Could not load resource availability' });
    }
  }

  return { handler, startScan, getSnapshot, probeService };
}

module.exports = {
  createResourceAvailability,
  isHttpUrl,
  classify,
  SLOW_THRESHOLD_MS,
  DEFAULT_REFRESH_MS,
  MAX_CHECKS,
};
