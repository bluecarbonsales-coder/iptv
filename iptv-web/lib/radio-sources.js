'use strict';

// Simple, persistent Radio settings. The public Radio Browser directory is enabled
// by default; additional stations are individual HTTP(S) stream URLs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function registryPath(dataDir) {
  return path.join(dataDir, 'radio-sources.json');
}

function loadSync(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.stations)) {
      return { directoryEnabled: raw.directoryEnabled !== false, allSourcesEnabledOnce: raw.allSourcesEnabledOnce === true, stations: raw.stations };
    }
  } catch {}
  return { directoryEnabled: true, allSourcesEnabledOnce: false, stations: [] };
}

function save(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = registryPath(dataDir);
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({
    version: 1,
    directoryEnabled: config.directoryEnabled !== false,
    allSourcesEnabledOnce: config.allSourcesEnabledOnce === true,
    stations: Array.isArray(config.stations) ? config.stations : [],
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function ensureEnabled(dataDir) {
  const config = loadSync(dataDir);
  if (config.allSourcesEnabledOnce) return false;
  const changed = config.directoryEnabled === false || config.stations.some((item) => item.enabled === false);
  config.directoryEnabled = true;
  for (const item of config.stations) item.enabled = true;
  config.allSourcesEnabledOnce = true;
  save(dataDir, config);
  return changed;
}

function clean(value, max = 120) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function validateStation(input) {
  const name = clean(input && input.name, 100);
  const rawUrl = clean(input && input.url, 2048);
  if (!name) throw Object.assign(new Error('Station name is required'), { statusCode: 400 });
  let url;
  try { url = new URL(rawUrl); } catch { throw Object.assign(new Error('Station URL must start with http:// or https://'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw Object.assign(new Error('Station URL must be a plain HTTP(S) URL'), { statusCode: 400 });
  }
  url.hash = '';
  return {
    id: crypto.randomUUID(),
    name,
    url: url.toString(),
    language: clean(input && input.language, 80),
    country: clean(input && input.country, 80),
    countrycode: clean(input && input.countrycode, 2).toUpperCase(),
    genre: clean(input && input.genre, 100),
    homepage: clean(input && input.homepage, 2048),
    enabled: input && input.enabled === false ? false : true,
    addedAt: new Date().toISOString(),
  };
}

function list(dataDir) {
  const config = loadSync(dataDir);
  return [
    { id: 'radio-browser', type: 'directory', name: 'Radio Browser directory', url: 'https://www.radio-browser.info/', enabled: config.directoryEnabled, count: null },
    ...config.stations.map((station) => ({
      id: station.id,
      type: 'station',
      name: station.name,
      url: station.url,
      language: station.language || '',
      country: station.country || '',
      genre: station.genre || '',
      enabled: station.enabled !== false,
      count: 1,
      error: station.lastError || null,
    })),
  ];
}

function add(dataDir, input) {
  const config = loadSync(dataDir);
  if (config.stations.length >= 500) throw Object.assign(new Error('Maximum of 500 custom radio stations reached'), { statusCode: 409 });
  const station = validateStation(input);
  if (config.stations.some((item) => item.url === station.url)) throw Object.assign(new Error('This radio URL already exists'), { statusCode: 409 });
  config.stations.push(station);
  config.allSourcesEnabledOnce = true;
  save(dataDir, config);
  return station;
}

function update(dataDir, id, patch) {
  const config = loadSync(dataDir);
  if (id === 'radio-browser') {
    if (patch.enabled === undefined) throw Object.assign(new Error('Set enabled to true or false'), { statusCode: 400 });
    config.directoryEnabled = patch.enabled === true;
    config.allSourcesEnabledOnce = true;
    save(dataDir, config);
    return list(dataDir)[0];
  }
  const station = config.stations.find((item) => item.id === id);
  if (!station) throw Object.assign(new Error('Radio source not found'), { statusCode: 404 });
  if (patch.enabled !== undefined) station.enabled = patch.enabled === true;
  if (patch.name !== undefined) station.name = clean(patch.name, 100);
  if (patch.url !== undefined) {
    const validated = validateStation({ ...station, ...patch });
    if (config.stations.some((item) => item.id !== id && item.url === validated.url)) throw Object.assign(new Error('This radio URL already exists'), { statusCode: 409 });
    station.url = validated.url;
  }
  config.allSourcesEnabledOnce = true;
  save(dataDir, config);
  return { ...station };
}

function remove(dataDir, id) {
  if (id === 'radio-browser') throw Object.assign(new Error('The built-in Radio Browser directory cannot be deleted; disable it instead'), { statusCode: 400 });
  const config = loadSync(dataDir);
  const next = config.stations.filter((station) => station.id !== id);
  if (next.length === config.stations.length) throw Object.assign(new Error('Radio source not found'), { statusCode: 404 });
  config.stations = next;
  config.allSourcesEnabledOnce = true;
  save(dataDir, config);
  return true;
}

function enableAll(dataDir) {
  const config = loadSync(dataDir);
  config.directoryEnabled = true;
  for (const item of config.stations) item.enabled = true;
  config.allSourcesEnabledOnce = true;
  save(dataDir, config);
  return list(dataDir);
}

function stationById(dataDir, id) {
  const config = loadSync(dataDir);
  return config.stations.find((station) => station.id.toLowerCase() === String(id || '').toLowerCase() && station.enabled !== false) || null;
}

module.exports = { registryPath, loadSync, save, ensureEnabled, validateStation, list, add, update, remove, enableAll, stationById };
