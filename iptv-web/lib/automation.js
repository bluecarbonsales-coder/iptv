'use strict';
// Periodic VOD provider discovery and health checks.
// Automatic imports only poll operator-configured registry URLs; the app does not scan
// the Internet for arbitrary stream endpoints or silently trust random GitHub lists.
const fs = require('fs');
const path = require('path');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const vod = require('./vod');

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_NEW_PER_CYCLE = 24;
const HOURS = (name, fallback, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.min(24 * 30, n)) : fallback;
};
const intervalMs = () => HOURS('AUTO_SOURCE_SYNC_HOURS', 12, 1) * 3600000;
const autonomy = () => String(process.env.AGENT_AUTONOMY || 'review').toLowerCase();

function registryUrls() {
  return String(process.env.VOD_SOURCE_LIST_URLS || '')
    .split(/[\n,;]/)
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 32);
}
function auditPath(dataDir) {
  return path.join(dataDir, 'agent-audit.jsonl');
}
function audit(dataDir, entry) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      actor: entry.actor || 'automation',
      action: entry.action || 'unknown',
      status: entry.status || 'ok',
      ...(entry.sourceId ? { sourceId: String(entry.sourceId).slice(0, 100) } : {}),
      ...(entry.summary ? { summary: String(entry.summary).slice(0, 500) } : {}),
      ...(entry.jobId ? { jobId: String(entry.jobId).slice(0, 100) } : {}),
    };
    fs.appendFileSync(auditPath(dataDir), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch {}
}
function readAudit(dataDir, limit = 100) {
  try {
    const rows = fs.readFileSync(auditPath(dataDir), 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, limit)));
    return rows.map((row) => { try { return JSON.parse(row); } catch { return null; } }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}
async function readConfig(url) {
  const { response } = await upstreamFetch(url, { timeoutMs: 15000, extraHeaders: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Registry returned HTTP ' + response.status);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_REGISTRY_BYTES) throw new Error('Registry exceeds 1 MB');
  const body = await bodyToString(response);
  if (Buffer.byteLength(body, 'utf8') > MAX_REGISTRY_BYTES) throw new Error('Registry exceeds 1 MB');
  let parsed;
  try { parsed = JSON.parse(body.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Registry is not valid JSON'); }
  return vod.parseSourceList(parsed);
}
async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { output[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (reason) { output[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}
function normalizeName(name) {
  return String(name || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function createAutomation({ dataDir, catalog = null, refresh, log = () => {}, onProvidersChanged = () => {} }) {
  let inFlight = null;
  let timer = null;
  let startupTimer = null;
  let lastRun = null;
  let lastProviderCheck = null;
  let started = false;

  function status() {
    const registry = vod.loadSourcesSync(dataDir);
    return {
      enabled: process.env.AGENT_AUTOMATION_ENABLED !== '0',
      autonomy: autonomy(),
      intervalHours: HOURS('AUTO_SOURCE_SYNC_HOURS', 12, 1),
      liveRefreshHours: HOURS('REFRESH_HOURS', 12, 1),
      liveCatalogAgeHours: catalog && catalog.meta && catalog.meta.updated ? Math.max(0, Math.round((Date.now() - Date.parse(catalog.meta.updated)) / 360000) / 10) : null,
      configuredRegistryCount: registryUrls().length,
      providerCount: registry.sources.length,
      enabledProviderCount: registry.sources.filter((source) => source.enabled !== false).length,
      lastRun,
      lastProviderCheck,
      running: !!inFlight,
      nextRun: lastRun ? new Date(Date.parse(lastRun.finishedAt) + intervalMs()).toISOString() : null,
    };
  }

  async function syncSourceLists(actor = 'automation') {
    const urls = registryUrls();
    const report = { registriesChecked: 0, imported: 0, updated: 0, duplicates: 0, rejected: 0, errors: [] };
    if (autonomy() === 'off') {
      report.skipped = 'AGENT_AUTONOMY=off';
      audit(dataDir, { actor, action: 'source_list.sync', status: 'blocked', summary: 'Automatic source discovery disabled by policy' });
      return report;
    }
    if (!urls.length) return report;
    for (const listUrl of urls) {
      let candidates;
      try {
        candidates = await readConfig(listUrl);
        report.registriesChecked++;
      } catch (err) {
        report.errors.push({ host: (() => { try { return new URL(listUrl).host; } catch { return 'invalid'; } })(), error: String(err.message || err).slice(0, 180) });
        audit(dataDir, { actor, action: 'source_list.sync', status: 'error', summary: 'Could not read configured provider registry' });
        continue;
      }

      const registry = vod.loadSourcesSync(dataDir);
      const existingUrls = new Set(registry.sources.map((source) => source.api));
      const handled = new Set();
      const updates = [];
      const additions = [];
      const sourceCandidates = candidates.slice(0, MAX_NEW_PER_CYCLE);
      for (const candidate of sourceCandidates) {
        if (existingUrls.has(candidate.api)) {
          report.duplicates++;
          continue;
        }
        // If a trusted list changes the API URL for a previously imported provider with
        // the same name, treat it as an update and test before switching over.
        const prior = registry.sources.find((source) =>
          source.importedFrom === listUrl &&
          normalizeName(source.name) === normalizeName(candidate.name) &&
          !handled.has(source.id)
        );
        const record = {
          id: prior ? prior.id : vod.newId(),
          name: candidate.name,
          api: candidate.api,
          detail: candidate.detail || null,
          kind: candidate.kind,
          enabled: autonomy() === 'full',
          addedAt: prior ? prior.addedAt : new Date().toISOString(),
          lastChecked: null,
          lastError: null,
          importedFrom: listUrl,
        };
        if (autonomy() === 'full') {
          try {
            const probe = await vod.probeSource(record);
            record.lastChecked = new Date().toISOString();
            record.lastItemCount = probe.count;
          } catch (err) {
            report.rejected++;
            report.errors.push({ provider: candidate.name, error: String(err.message || err).slice(0, 180) });
            audit(dataDir, { actor, action: 'provider.auto_import', status: 'rejected', sourceId: record.id, summary: 'Candidate failed its compatibility probe' });
            continue;
          }
        } else {
          record.enabled = false;
          record.lastError = 'Imported in review mode; enable after checking compatibility and rights';
        }
        existingUrls.add(candidate.api);
        if (prior) {
          handled.add(prior.id);
          updates.push(record);
        } else {
          additions.push(record);
        }
      }

      const changedIds = new Set([...updates, ...additions].map((source) => source.id));
      if (changedIds.size) {
        const updatedExisting = registry.sources.map((source) => {
          const replacement = updates.find((candidate) => candidate.id === source.id);
          return replacement || source;
        });
        updatedExisting.push(...additions);
        vod.saveSources(dataDir, updatedExisting);
        report.imported += additions.length;
        report.updated += updates.length;
        for (const item of additions) audit(dataDir, {
          actor, action: 'provider.auto_import', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'New provider imported from configured registry ' + (item.enabled ? 'and probe passed' : 'as disabled'),
        });
        for (const item of updates) audit(dataDir, {
          actor, action: 'provider.auto_update', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'Imported provider endpoint refreshed from configured registry',
        });
      }
    }
    if (report.imported || report.updated) onProvidersChanged();
    audit(dataDir, { actor, action: 'source_list.sync', status: report.errors.length ? 'partial' : 'ok',
      summary: 'Registries ' + report.registriesChecked + '; imported ' + report.imported + '; updated ' + report.updated + '; duplicates ' + report.duplicates + '; rejected ' + report.rejected });
    return report;
  }

  async function checkProviders(actor = 'automation') {
    const registry = vod.loadSourcesSync(dataDir);
    const enabled = registry.sources.filter((source) => source.enabled !== false);
    let ok = 0;
    let failed = 0;
    const results = await mapLimit(enabled, 3, async (source) => {
      try {
        const probe = await vod.probeSource(source);
        source.lastChecked = new Date().toISOString();
        source.lastError = null;
        source.lastItemCount = probe.count;
        ok++;
        return { id: source.id, status: 'ok', count: probe.count };
      } catch (err) {
        source.lastChecked = new Date().toISOString();
        source.lastError = String(err.message || err).slice(0, 300);
        failed++;
        return { id: source.id, status: 'error', error: source.lastError };
      }
    });
    if (enabled.length) vod.saveSources(dataDir, registry.sources);
    lastProviderCheck = { at: new Date().toISOString(), total: enabled.length, ok, failed };
    audit(dataDir, { actor, action: 'provider.health_check', status: failed ? 'partial' : 'ok',
      summary: 'Checked ' + enabled.length + ' providers; healthy ' + ok + '; failed ' + failed });
    return { checked: enabled.length, ok, failed, results: results.map((entry) => entry.value || { status: 'error', error: String(entry.reason && entry.reason.message || 'check failed') }) };
  }

  async function refreshLiveIfDue(actor = 'automation') {
    if (!catalog || typeof refresh !== 'function') return { refreshed: false, reason: 'not_configured' };
    const ageHours = catalog.meta && catalog.meta.updated && Number.isFinite(Date.parse(catalog.meta.updated))
      ? (Date.now() - Date.parse(catalog.meta.updated)) / 3600000
      : Infinity;
    const maxAge = HOURS('REFRESH_HOURS', 12, 1);
    if (catalog.ready && ageHours <= maxAge) {
      return { refreshed: false, reason: 'catalog_is_fresh', ageHours: Math.round(ageHours * 10) / 10 };
    }
    const result = await refresh();
    audit(dataDir, {
      actor,
      action: 'catalog.refresh',
      status: 'ok',
      summary: 'Scheduled live catalog refresh completed',
    });
    return { refreshed: true, previousAgeHours: Number.isFinite(ageHours) ? Math.round(ageHours * 10) / 10 : null, result };
  }

  async function runCycle(actor = 'automation') {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const run = { id: 'job-' + Date.now().toString(36), actor, startedAt: new Date().toISOString(), status: 'running' };
      lastRun = run;
      audit(dataDir, { actor, action: 'automation.cycle', status: 'started', jobId: run.id, summary: 'Automatic source maintenance started' });
      try {
        run.discovery = await syncSourceLists(actor);
        run.health = await checkProviders(actor);
        run.liveCatalog = await refreshLiveIfDue(actor);
        run.status = 'completed';
      } catch (err) {
        run.status = 'failed';
        run.error = String(err.message || err).slice(0, 300);
      }
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
      audit(dataDir, { actor, action: 'automation.cycle', status: run.status, jobId: run.id, summary: 'Automatic source maintenance ' + run.status });
      return run;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function task(name, actor = 'agent') {
    if (name === 'sync_source_lists') return syncSourceLists(actor);
    if (name === 'check_vod_providers') return checkProviders(actor);
    if (name === 'maintain_sources') return runCycle(actor);
    if (name === 'refresh_live_catalog') {
      const result = await refresh();
      audit(dataDir, { actor, action: 'catalog.refresh', status: 'ok', summary: 'Live IPTV catalogue refreshed' });
      return result;
    }
    throw Object.assign(new Error('Unsupported task. Use sync_source_lists, check_vod_providers, maintain_sources, or refresh_live_catalog.'), { statusCode: 400 });
  }

  function start() {
    if (started || process.env.AGENT_AUTOMATION_ENABLED === '0') return;
    started = true;
    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        runCycle('scheduler').catch((err) => log('source maintenance failed:', err.message));
      }, intervalMs());
      timer.unref && timer.unref();
    };
    startupTimer = setTimeout(() => {
      runCycle('startup').catch((err) => log('source maintenance failed:', err.message));
      schedule();
    }, 30000);
    startupTimer.unref && startupTimer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    timer = startupTimer = null;
    started = false;
  }

  return { status, syncSourceLists, checkProviders, refreshLiveIfDue, runCycle, task, start, stop, audit: (entry) => audit(dataDir, entry), readAudit: (limit) => readAudit(dataDir, limit) };
}
module.exports = { createAutomation, audit, readAudit, registryUrls };
