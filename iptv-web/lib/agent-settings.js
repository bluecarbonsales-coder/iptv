'use strict';
const fs = require('fs');
const path = require('path');

const VALID_AUTONOMY = new Set(['full', 'review', 'off']);
const MAX_REGISTRIES = 32;
const MIN_HOURS = 1;
const MAX_HOURS = 720;

function uniqueRegistryUrls(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,;]/);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch { throw new Error('Registry URLs must be valid absolute URLs'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Registry URLs must use HTTP(S) and must not include embedded credentials');
    }
    url.hash = '';
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length > MAX_REGISTRIES) throw new Error('At most ' + MAX_REGISTRIES + ' registries can be configured');
  }
  return out;
}
function hours(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) throw new Error('Schedule intervals must be numbers of hours');
  return Math.max(MIN_HOURS, Math.min(MAX_HOURS, num));
}
function settingsPath(dataDir) {
  return path.join(dataDir, 'agent-settings.json');
}
function environmentHours(name, fallback) {
  try { return hours(process.env[name], fallback); }
  catch { return fallback; }
}
function environmentRegistryUrls() {
  try { return uniqueRegistryUrls(process.env.VOD_SOURCE_LIST_URLS || ''); }
  catch { return []; }
}
function defaults() {
  const autonomy = String(process.env.AGENT_AUTONOMY || 'full').toLowerCase();
  return {
    version: 1,
    autonomy: VALID_AUTONOMY.has(autonomy) ? autonomy : 'full',
    automationEnabled: process.env.AGENT_AUTOMATION_ENABLED !== '0',
    autoSourceSyncHours: environmentHours('AUTO_SOURCE_SYNC_HOURS', 12),
    refreshHours: environmentHours('REFRESH_HOURS', 12),
    sourceListUrls: environmentRegistryUrls(),
  };
}
function getSettings(dataDir) {
  const base = defaults();
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    return validatePatch({ ...base, ...saved }, base);
  } catch (err) {
    // Missing settings is normal on a first run; corrupt settings must not stop service boot.
    return base;
  }
}
function validatePatch(patch, current) {
  const next = { ...current };
  if (patch.autonomy !== undefined) {
    const autonomy = String(patch.autonomy).toLowerCase();
    if (!VALID_AUTONOMY.has(autonomy)) throw new Error('autonomy must be full, review, or off');
    next.autonomy = autonomy;
  }
  if (patch.automationEnabled !== undefined) {
    if (typeof patch.automationEnabled !== 'boolean') throw new Error('automationEnabled must be a boolean');
    next.automationEnabled = patch.automationEnabled;
  }
  if (patch.autoSourceSyncHours !== undefined) next.autoSourceSyncHours = hours(patch.autoSourceSyncHours, current.autoSourceSyncHours);
  if (patch.refreshHours !== undefined) next.refreshHours = hours(patch.refreshHours, current.refreshHours);
  if (patch.sourceListUrls !== undefined) next.sourceListUrls = uniqueRegistryUrls(patch.sourceListUrls);
  next.version = 1;
  return next;
}
function updateSettings(dataDir, patch) {
  const current = getSettings(dataDir);
  const next = validatePatch(patch, current);
  fs.mkdirSync(dataDir, { recursive: true });
  const target = settingsPath(dataDir);
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, target);
  return next;
}
module.exports = { VALID_AUTONOMY, MAX_REGISTRIES, settingsPath, defaults, getSettings, updateSettings, uniqueRegistryUrls, validatePatch };
