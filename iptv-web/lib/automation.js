'use strict';
// Periodic VOD provider discovery and health checks.
// Automatic imports only poll operator-configured registry URLs; the app does not scan
// the Internet for arbitrary stream endpoints or silently trust random GitHub lists.
const fs = require('fs');
const path = require('path');
const { upstreamFetch, bodyToString } = require('./fetch-upstream');
const vod = require('./vod');
const live = require('./sources');
const { withLock, withFileLock } = require('./registry-lock');
const settingsLib = require('./agent-settings');

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_NEW_PER_CYCLE = 24;
const intervalMs = (dataDir) => settingsLib.getSettings(dataDir).autoSourceSyncHours * 3600000;
const autonomy = (dataDir) => settingsLib.getSettings(dataDir).autonomy;

function registryUrls(dataDir) {
  return settingsLib.getSettings(dataDir).sourceListUrls;
}
function registryUrlSummary(raw) {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname + (url.search ? '?[query-redacted]' : '');
  } catch {
    return '[invalid URL]';
  }
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
  try { return JSON.parse(body.replace(/^\\uFEFF/, '')); }
  catch { throw new Error('Registry is not valid JSON'); }
}
function parseLiveRegistry(config) {
  return live.parseRegistrySources(config);
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
  const withLiveLock = (fn) => withFileLock(live.sourcesPath(dataDir) + '.lock', () => withLock('live-sources:' + dataDir, fn));

  function status() {
    const registry = vod.loadSourcesSync(dataDir);
    return {
      enabled: settingsLib.getSettings(dataDir).automationEnabled,
      autonomy: autonomy(dataDir),
      intervalHours: settingsLib.getSettings(dataDir).autoSourceSyncHours,
      liveRefreshHours: settingsLib.getSettings(dataDir).refreshHours,
      registryUrls: registryUrls(dataDir).map(registryUrlSummary),
      liveCatalogAgeHours: catalog && catalog.meta && catalog.meta.updated ? Math.max(0, Math.round((Date.now() - Date.parse(catalog.meta.updated)) / 360000) / 10) : null,
      configuredRegistryCount: registryUrls(dataDir).length,
      providerCount: registry.sources.length,
      enabledProviderCount: registry.sources.filter((source) => source.enabled !== false).length,
      lastRun,
      lastProviderCheck,
      running: !!inFlight,
      nextRun: lastRun ? new Date(Date.parse(lastRun.finishedAt) + intervalMs(dataDir)).toISOString() : null,
    };
  }

  async function syncSourceLists(actor = 'automation') {
    const urls = registryUrls(dataDir);
    const report = {
      registriesChecked: 0, vodImported: 0, vodUpdated: 0, liveImported: 0, liveUpdated: 0,
      duplicates: 0, rejected: 0, errors: [],
    };
    report.imported = 0;
    report.updated = 0;
    report.liveChanged = false;
    if (autonomy(dataDir) === 'off') {
      report.skipped = 'AGENT_AUTONOMY=off';
      audit(dataDir, { actor, action: 'source_list.sync', status: 'blocked', summary: 'Automatic provider discovery disabled by policy' });
      return report;
    }
    if (!urls.length) return report;

    for (const listUrl of urls) {
      let config;
      let vodCandidates = [];
      let liveCandidates = [];
      try {
        config = await readConfig(listUrl);
        try { vodCandidates = vod.parseSourceList(config); } catch (err) {
          if (!Array.isArray(config.liveSources)) throw err;
        }
        liveCandidates = parseLiveRegistry(config);
        if (!vodCandidates.length && !liveCandidates.length) throw new Error('Registry has no compatible VOD sources[] / api_site{} / sites[] or liveSources[] entries');
        report.registriesChecked++;
      } catch (err) {
        report.errors.push({
          host: (() => { try { return new URL(listUrl).host; } catch { return 'invalid'; } })(),
          error: String(err.message || err).slice(0, 180),
        });
        audit(dataDir, { actor, action: 'source_list.sync', status: 'error', summary: 'Could not read a compatible configured provider registry' });
        continue;
      }

      // VOD registry sync: providers are probed before activation in full autonomy mode.
      const initialVod = vod.loadSourcesSync(dataDir).sources;
      const existingVodUrls = new Set(initialVod.map((source) => source.api));
      const handledVod = new Set();
      const vodUpdates = [];
      const vodAdditions = [];
      for (const candidate of vodCandidates.slice(0, MAX_NEW_PER_CYCLE)) {
        const sameEndpoint = initialVod.find((source) => source.api === candidate.api);
        if (sameEndpoint) {
          if (sameEndpoint.importedFrom === listUrl) {
            const metadataUpdated = {
              ...sameEndpoint,
              name: candidate.name,
              detail: candidate.detail || null,
              kind: candidate.kind,
              importedFrom: listUrl,
            };
            const changed = metadataUpdated.name !== sameEndpoint.name ||
              metadataUpdated.detail !== (sameEndpoint.detail || null) ||
              metadataUpdated.kind !== sameEndpoint.kind;
            if (changed) vodUpdates.push(metadataUpdated);
            else report.duplicates++;
          } else {
            report.duplicates++;
          }
          continue;
        }
        const prior = initialVod.find((source) =>
          source.importedFrom === listUrl &&
          normalizeName(source.name) === normalizeName(candidate.name) &&
          !handledVod.has(source.id)
        );
        const record = {
          id: prior ? prior.id : vod.newId(),
          name: candidate.name,
          api: candidate.api,
          detail: candidate.detail || null,
          kind: candidate.kind,
          enabled: prior ? (autonomy(dataDir) === 'full' ? true : prior.enabled !== false) : autonomy(dataDir) === 'full',
          addedAt: prior ? prior.addedAt : new Date().toISOString(),
          lastChecked: prior ? prior.lastChecked || null : null,
          lastError: prior ? prior.lastError || null : null,
          lastItemCount: prior ? prior.lastItemCount ?? null : null,
          importedFrom: listUrl,
        };
        if (autonomy(dataDir) === 'full') {
          try {
            const probe = await vod.probeSource(record);
            record.lastChecked = new Date().toISOString();
            record.lastItemCount = probe.count;
          } catch (err) {
            report.rejected++;
            report.errors.push({ provider: candidate.name, error: String(err.message || err).slice(0, 180) });
            audit(dataDir, { actor, action: 'provider.auto_import', status: 'rejected', sourceId: record.id, summary: 'VOD candidate failed compatibility probe' });
            continue;
          }
        } else {
          record.enabled = false;
          record.lastError = 'Imported in review mode; enable after checking compatibility and rights';
        }
        existingVodUrls.add(candidate.api);
        if (prior) {
          handledVod.add(prior.id);
          vodUpdates.push(record);
        } else {
          vodAdditions.push(record);
        }
      }
      if (vodUpdates.length || vodAdditions.length) {
        await withLock('vod-sources:' + dataDir, () => {
          const current = vod.loadSourcesSync(dataDir).sources;
          const currentUrls = new Set(current.map((source) => source.api));
          const safeAdds = vodAdditions.filter((item) => !currentUrls.has(item.api));
          const replacements = new Map(vodUpdates.map((item) => [item.id, item]));
          const next = current.map((item) => currentUrls.has(item.api) ? (replacements.get(item.id) || item) : item);
          const knownIds = new Set(next.map((item) => item.id));
          next.push(...safeAdds.filter((item) => !knownIds.has(item.id)));
          vod.saveSources(dataDir, next);
          report.vodImported += safeAdds.length;
          report.vodUpdated += vodUpdates.filter((item) => current.some((currentItem) => currentItem.id === item.id)).length;
        });
        for (const item of vodAdditions) audit(dataDir, {
          actor, action: 'provider.auto_import', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'VOD provider discovered from configured registry',
        });
        for (const item of vodUpdates) audit(dataDir, {
          actor, action: 'provider.auto_update', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'VOD endpoint updated from configured registry',
        });
      }

      // Live sources in LibreTV SourceList v2 use liveSources[]. Test them before activation.
      const initialLive = live.loadSourcesSync(dataDir).sources;
      const existingLiveUrls = new Set(initialLive.map((source) => source.url));
      const handledLive = new Set();
      const liveUpdates = [];
      const liveAdditions = [];
      for (const candidate of liveCandidates.slice(0, MAX_NEW_PER_CYCLE)) {
        const sameEndpoint = initialLive.find((source) => source.url === candidate.url);
        if (sameEndpoint) {
          if (sameEndpoint.importedFrom === listUrl) {
            const metadataUpdated = {
              ...sameEndpoint,
              name: candidate.name,
              epg: candidate.epg,
              importedFrom: listUrl,
            };
            if (metadataUpdated.name !== sameEndpoint.name || metadataUpdated.epg !== (sameEndpoint.epg || null)) {
              liveUpdates.push(metadataUpdated);
            } else {
              report.duplicates++;
            }
          } else {
            report.duplicates++;
          }
          continue;
        }
        const prior = initialLive.find((source) =>
          source.importedFrom === listUrl &&
          normalizeName(source.name) === normalizeName(candidate.name) &&
          !handledLive.has(source.id)
        );
        const record = {
          id: prior ? prior.id : live.newId(),
          name: candidate.name,
          url: candidate.url,
          epg: candidate.epg,
          enabled: prior ? (autonomy(dataDir) === 'full' ? true : prior.enabled !== false) : autonomy(dataDir) === 'full',
          createdAt: prior ? prior.createdAt : new Date().toISOString(),
          importedFrom: listUrl,
        };
        if (autonomy(dataDir) === 'full') {
          try {
            const parsedItems = await live.fetchSource(record);
            record.lastCount = live.buildChannels(record, parsedItems).length;
            record.lastStreamCount = parsedItems.length;
            record.lastUpdated = new Date().toISOString();
            record.lastError = null;
          } catch (err) {
            report.rejected++;
            report.errors.push({ provider: candidate.name, error: String(err.message || err).slice(0, 180) });
            audit(dataDir, { actor, action: 'live_source.auto_import', status: 'rejected', sourceId: record.id, summary: 'Live playlist failed validation' });
            continue;
          }
        } else {
          record.enabled = false;
          record.lastError = 'Imported in review mode; enable after checking compatibility and rights';
        }
        existingLiveUrls.add(candidate.url);
        if (prior) {
          handledLive.add(prior.id);
          liveUpdates.push(record);
        } else {
          liveAdditions.push(record);
        }
      }
      if (liveUpdates.length || liveAdditions.length) {
        await withLiveLock(() => {
          const current = live.loadSourcesSync(dataDir).sources;
          const currentUrls = new Set(current.map((source) => source.url));
          const safeAdds = liveAdditions.filter((item) => !currentUrls.has(item.url));
          const replacements = new Map(liveUpdates.map((item) => [item.id, item]));
          const next = current.map((item) => replacements.get(item.id) || item);
          const knownIds = new Set(next.map((item) => item.id));
          next.push(...safeAdds.filter((item) => !knownIds.has(item.id)));
          live.saveSources(dataDir, next);
          report.liveImported += safeAdds.length;
          report.liveUpdated += liveUpdates.filter((item) => current.some((currentItem) => currentItem.id === item.id)).length;
          if (safeAdds.length || liveUpdates.length) report.liveChanged = true;
        });
        for (const item of liveAdditions) audit(dataDir, {
          actor, action: 'live_source.auto_import', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'Live playlist discovered from configured registry',
        });
        for (const item of liveUpdates) audit(dataDir, {
          actor, action: 'live_source.auto_update', status: item.enabled ? 'enabled' : 'pending_review',
          sourceId: item.id, summary: 'Live playlist endpoint updated from configured registry',
        });
      }
    }
    report.imported = report.vodImported + report.liveImported;
    report.updated = report.vodUpdated + report.liveUpdated;
    if (report.vodImported || report.vodUpdated) onProvidersChanged();
    audit(dataDir, {
      actor, action: 'source_list.sync', status: report.errors.length ? 'partial' : 'ok',
      summary: 'Registries ' + report.registriesChecked +
        '; VOD +' + report.vodImported + '/~' + report.vodUpdated +
        '; live +' + report.liveImported + '/~' + report.liveUpdated +
        '; duplicates ' + report.duplicates + '; rejected ' + report.rejected,
    });
    return report;
  }

  async function checkProviders(actor = 'automation') {
    const snapshot = vod.loadSourcesSync(dataDir).sources;
    const enabled = snapshot.filter((source) => source.enabled !== false);
    let ok = 0;
    let failed = 0;
    const results = await mapLimit(enabled, 3, async (source) => {
      try {
        const probe = await vod.probeSource(source);
        ok++;
        return {
          id: source.id,
          status: 'ok',
          count: probe.count,
          statusFields: { lastChecked: new Date().toISOString(), lastError: null, lastItemCount: probe.count },
        };
      } catch (err) {
        failed++;
        const error = String(err.message || err).slice(0, 300);
        return {
          id: source.id,
          status: 'error',
          error,
          statusFields: { lastChecked: new Date().toISOString(), lastError: error },
        };
      }
    });
    if (enabled.length) {
      await withLock('vod-sources:' + dataDir, () => {
        const current = vod.loadSourcesSync(dataDir).sources;
        const statuses = new Map(results.filter((entry) => entry.status === 'fulfilled').map((entry) => [entry.value.id, entry.value.statusFields]));
        for (const source of current) {
          const fields = statuses.get(source.id);
          if (fields) Object.assign(source, fields);
        }
        vod.saveSources(dataDir, current);
      });
    }
    lastProviderCheck = { at: new Date().toISOString(), total: enabled.length, ok, failed };
    audit(dataDir, { actor, action: 'provider.health_check', status: failed ? 'partial' : 'ok',
      summary: 'Checked ' + enabled.length + ' providers; healthy ' + ok + '; failed ' + failed });
    return {
      checked: enabled.length,
      ok,
      failed,
      results: results.map((entry) => entry.status === 'fulfilled' ? ({
        id: entry.value.id, status: entry.value.status, count: entry.value.count, error: entry.value.error,
      }) : ({ status: 'error', error: String(entry.reason && entry.reason.message || 'check failed') })),
    };
  }

  async function refreshLiveIfDue(actor = 'automation') {
    if (!catalog || typeof refresh !== 'function') return { refreshed: false, reason: 'not_configured' };
    const ageHours = catalog.meta && catalog.meta.updated && Number.isFinite(Date.parse(catalog.meta.updated))
      ? (Date.now() - Date.parse(catalog.meta.updated)) / 3600000
      : Infinity;
    const maxAge = settingsLib.getSettings(dataDir).refreshHours;
    const liveSources = live.loadSourcesSync(dataDir).sources.filter((source) => source.enabled !== false);
    const liveNeedsRefresh = liveSources.some((source) => {
      const updated = source.lastUpdated ? Date.parse(source.lastUpdated) : NaN;
      return !Number.isFinite(updated) || Date.now() - updated > maxAge * 3600000;
    });
    if (catalog.ready && ageHours <= maxAge && !liveNeedsRefresh) {
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
        if (run.discovery && run.discovery.liveChanged) {
          const refreshed = await refresh();
          run.liveResourceRefresh = { refreshed: true, reason: 'provider_registry_changed', result: refreshed };
          audit(dataDir, { actor, action: 'live_source.catalog_refresh', status: 'ok', jobId: run.id, summary: 'Refreshed live catalogue after registry changed' });
        }
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
    if (started || !settingsLib.getSettings(dataDir).automationEnabled) return;
    started = true;
    const schedule = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        runCycle('scheduler').catch((err) => log('source maintenance failed:', err.message));
      }, intervalMs(dataDir));
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

  async function updateSettings(patch, actor = 'agent') {
    const next = await withLock('agent-settings:' + dataDir, () => settingsLib.updateSettings(dataDir, patch));
    stop();
    if (next.automationEnabled) start();
    audit(dataDir, { actor, action: 'settings.update', status: 'ok', summary: 'Updated agent runtime settings; automation ' + (next.automationEnabled ? 'enabled' : 'disabled') + '; autonomy ' + next.autonomy });
    return next;
  }

  return { status, syncSourceLists, checkProviders, refreshLiveIfDue, runCycle, task, start, stop, getSettings: () => settingsLib.getSettings(dataDir), updateSettings, audit: (entry) => audit(dataDir, entry), readAudit: (limit) => readAudit(dataDir, limit) };
}
module.exports = { createAutomation, audit, readAudit, registryUrls };
