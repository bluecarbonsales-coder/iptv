'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readBody, sendJson } = require('./util');

const MAX_SERVICES = 200;
const DEFAULT_SERVICES = [
  { id: 'watch-tv', name: 'Live TV', url: '/watch.html', description: 'Live channels, channel groups and your own playlists.', category: 'Media', icon: '▶', featured: true, order: 0 },
  { id: 'theatre', name: 'Theatre', url: '/movies.html', description: 'A dedicated cinema for movies, TV series, anime, animation and documentaries.', category: 'Media', icon: '▻', featured: true, order: 1 },
  { id: 'nodecast-tv', name: 'Nodecast TV', url: 'https://player.nafisainternational.com', description: 'Full IPTV player with live channels, EPG, movies and series.', category: 'Media', icon: '▣', featured: true, order: 2 },
  { id: 'public-radio', name: 'Public Radio', url: '/radio.html', description: 'Explore live public radio stations by country, language and genre.', category: 'Media', icon: '♫', featured: true, order: 5 },
  { id: 'seedhub', name: 'SeedHub', url: 'https://www.seedhub.cc/', description: 'External movie and TV catalog. Website availability does not guarantee media playback or content rights.', category: 'Media resources', icon: 'S', featured: false, order: 95 },
  { id: 'streambert', name: 'Streambert', url: 'https://github.com/truelockmc/streambert', description: 'Official Streambert desktop-app repository and releases; this is not a VOD API endpoint.', category: 'Media resources', icon: 'B', featured: false, order: 96 },
  { id: 'nafisa-site', name: 'Nafisa International', url: 'https://nafisainternational.com', description: 'Company website and global trade services.', category: 'Work', icon: 'N', featured: true, order: 10 },
  { id: 'mail', name: 'Email', url: 'https://email.nafisainternational.com', description: 'Open the self-hosted mail service.', category: 'Work', icon: '✉', featured: true, order: 20 },
  { id: 'home-dashboard', name: 'Home dashboard', url: 'https://home.nafisainternational.com', description: 'Shortcuts and status for self-hosted services.', category: 'Self-hosted', icon: '⌂', featured: false, order: 30 },
  { id: 'files', name: 'File browser', url: 'https://filebrowser.nafisainternational.com', description: 'Browse and manage your files.', category: 'Self-hosted', icon: '▤', featured: false, order: 40 },
  { id: 'ai-admin', name: 'AI Control Center', url: 'https://ai-admin.nafisainternational.com', description: 'Open the private AI administration dashboard.', category: 'Self-hosted', icon: '✦', featured: true, order: 50 },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', description: 'AI assistant and workspace.', category: 'AI & tools', icon: '✳', featured: false, order: 60 },
  { id: 'github', name: 'GitHub', url: 'https://github.com', description: 'Code, repositories and project automation.', category: 'Developer', icon: '⌘', featured: false, order: 70 },
  { id: 'cloudflare', name: 'Cloudflare', url: 'https://dash.cloudflare.com', description: 'DNS, Zero Trust and tunnels.', category: 'Developer', icon: '◈', featured: false, order: 80 },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com', description: 'Video and channels.', category: 'Media', icon: '▷', featured: false, order: 90 },
  { id: 'wikipedia', name: 'Wikipedia', url: 'https://www.wikipedia.org', description: 'A multilingual reference library.', category: 'Reference', icon: 'W', featured: false, order: 100 },
];

function isSafeServiceUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) return false;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//')) return false;
    const pathPart = raw.split(/[?#]/, 1)[0];
    return !pathPart.split('/').some((part) => part === '..');
  }
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      !!parsed.hostname && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function validateService(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('service must be an object');
  const name = String(input.name == null ? '' : input.name).trim();
  if (!name || name.length > 80) throw new Error('name must contain 1–80 characters');
  const url = String(input.url == null ? '' : input.url).trim();
  if (!isSafeServiceUrl(url)) throw new Error('URL must be a safe relative path or an http(s) URL without embedded credentials');
  const description = String(input.description == null ? '' : input.description).trim().slice(0, 180);
  const category = String(input.category == null || input.category === '' ? 'Other' : input.category).trim();
  if (!category || category.length > 32) throw new Error('category must contain 1–32 characters');
  const icon = String(input.icon == null || input.icon === '' ? '↗' : input.icon).trim();
  if (!icon || icon.length > 24) throw new Error('icon must contain 1–24 characters');
  let order = Number(input.order);
  if (!Number.isFinite(order)) order = 1000;
  order = Math.max(-10000, Math.min(10000, Math.trunc(order)));
  return {
    name,
    url,
    description,
    category,
    icon,
    featured: input.featured === true,
    order,
  };
}

function matchesToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const actual = Buffer.from(given);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

function createPortalApi(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const storePath = path.join(dataDir, 'portal-services.json');
  let mutationQueue = Promise.resolve();

  function writeStore(services) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tempPath = storePath + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify({ version: 4, services }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempPath, storePath);
  }

  function loadServices() {
    if (!fs.existsSync(storePath)) {
      writeStore(DEFAULT_SERVICES.map((service) => ({ ...service, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch (err) {
      throw new Error('portal service data could not be read: ' + err.message);
    }
    if (!parsed || !Array.isArray(parsed.services)) throw new Error('portal service data has an invalid format');
    // One-time migration for existing data volumes: add newer built-in shortcuts once,
    // but do not resurrect a shortcut after the owner removes it from the portal.
    const version = Number(parsed.version) || 1;
    if (version < 2) {
      for (const item of DEFAULT_SERVICES.filter((service) => ['public-radio', 'seedhub', 'streambert'].includes(service.id))) {
        if (!parsed.services.some((service) => service && service.id === item.id)) {
          const now = new Date().toISOString();
          parsed.services.push({ ...item, createdAt: now, updatedAt: now });
        }
      }
    }
    if (version < 3) {
      const item = DEFAULT_SERVICES.find((service) => service.id === 'theatre');
      if (item && !parsed.services.some((service) => service && service.id === item.id)) {
        const now = new Date().toISOString();
        parsed.services.push({ ...item, createdAt: now, updatedAt: now });
      }
      writeStore(parsed.services);
    }
    if (version < 4) {
      const item = DEFAULT_SERVICES.find((service) => service.id === 'nodecast-tv');
      if (item && !parsed.services.some((service) => service && service.id === item.id)) {
        const now = new Date().toISOString();
        parsed.services.push({ ...item, createdAt: now, updatedAt: now });
      }
      writeStore(parsed.services);
    }
    return parsed.services;
  }

  function mutate(fn) {
    const next = mutationQueue.then(fn);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function authorize(req, res) {
    const expected = process.env.AGENT_API_TOKEN || '';
    const given = req.headers['x-agent-token'];
    const matches = typeof given === 'string' && expected &&
      Buffer.from(given).length === Buffer.from(expected).length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (matches) return true;
    if (!expected) {
      sendJson(req, res, 503, { error: 'portal configuration writes are disabled until AGENT_API_TOKEN is configured' });
    } else {
      sendJson(req, res, 403, { error: 'portal configuration writes are restricted to the authenticated Hermes agent API' });
    }
    return false;
  }

  function list(req, res) {
    try {
      if (new URL(req.url, 'http://localhost').searchParams.get('manage') === '1' && !authorize(req, res)) return;
      const services = loadServices().slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name).localeCompare(String(b.name)));
      sendJson(req, res, 200, { services, canManage: new URL(req.url, 'http://localhost').searchParams.get('manage') === '1' });
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || 'could not load service links' });
    }
  }

  async function add(req, res) {
    if (!authorize(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 32768));
      const valid = validateService(body);
      const result = await mutate(() => {
        const services = loadServices();
        if (services.length >= MAX_SERVICES) throw Object.assign(new Error('service limit reached (' + MAX_SERVICES + ')'), { statusCode: 409 });
        const now = new Date().toISOString();
        const service = { id: crypto.randomUUID(), ...valid, createdAt: now, updatedAt: now };
        services.push(service);
        writeStore(services);
        return service;
      });
      sendJson(req, res, 201, { service: result });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not add service' });
    }
  }

  async function update(req, res, params) {
    if (!authorize(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req, 32768));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('request body must be an object');
      const allowed = ['name', 'url', 'description', 'category', 'icon', 'featured', 'order'];
      const result = await mutate(() => {
        const services = loadServices();
        const index = services.findIndex((service) => service.id === params.id);
        if (index < 0) throw Object.assign(new Error('service not found'), { statusCode: 404 });
        const current = services[index];
        const patch = {};
        for (const key of allowed) if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
        const updated = { ...current, ...validateService({ ...current, ...patch }), updatedAt: new Date().toISOString() };
        services[index] = updated;
        writeStore(services);
        return updated;
      });
      sendJson(req, res, 200, { service: result });
    } catch (err) {
      sendJson(req, res, err.statusCode || 400, { error: err.message || 'could not update service' });
    }
  }

  async function remove(req, res, params) {
    if (!authorize(req, res)) return;
    try {
      const removed = await mutate(() => {
        const services = loadServices();
        const next = services.filter((service) => service.id !== params.id);
        if (next.length === services.length) throw Object.assign(new Error('service not found'), { statusCode: 404 });
        writeStore(next);
        return true;
      });
      sendJson(req, res, 200, { ok: removed });
    } catch (err) {
      sendJson(req, res, err.statusCode || 500, { error: err.message || 'could not delete service' });
    }
  }

  return { list, add, update, remove, getServices: loadServices };
}

module.exports = { createPortalApi, isSafeServiceUrl, validateService, matchesToken, DEFAULT_SERVICES, MAX_SERVICES };
