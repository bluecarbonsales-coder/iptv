'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_NAVIGATION = {
  version: 1,
  items: [
    { id: 'home', label: 'For you', href: '#home', section: 'all', group: 'Discover', order: 0, enabled: true },
    { id: 'movies', label: 'Movies', href: '#movies', section: 'movies', group: 'Discover', order: 10, enabled: true },
    { id: 'series', label: 'TV Series', href: '#series', section: 'series', group: 'Discover', order: 20, enabled: true },
    { id: 'anime', label: 'Anime & Animation', href: '#anime', section: 'anime', group: 'Discover', order: 30, enabled: true },
    { id: 'documentary', label: 'Documentaries', href: '#documentaries', section: 'documentary', group: 'Discover', order: 40, enabled: true },
    { id: 'favorites', label: 'My watchlist', href: '#favorites', section: 'favorites', group: 'Discover', order: 50, enabled: true },
    { id: 'live-tv', label: 'Live TV', href: '/watch.html', group: 'Media', order: 60, enabled: true },
    { id: 'radio', label: 'Radio', href: '/radio.html', group: 'Media', order: 70, enabled: true },
    { id: 'mail', label: 'Mail', href: '/mail.html', group: 'Services', order: 80, enabled: true },
  ],
};

function safeHref(value) {
  const href = String(value || '').trim();
  if (!href || href.length > 512 || /[\u0000-\u001f\u007f\\]/.test(href) || href.startsWith('//')) return false;
  if (href.startsWith('#')) return /^#[a-zA-Z0-9_-]+$/.test(href);
  if (href.startsWith('/')) return !href.split(/[?#]/, 1)[0].split('/').includes('..');
  try {
    const u = new URL(href);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password;
  } catch { return false; }
}

function validateNavigation(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items)) throw new Error('navigation config must contain an items array');
  if (input.items.length > 100) throw new Error('navigation can contain at most 100 items');
  const seen = new Set();
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('each navigation item must be an object');
    const id = String(item.id || '').trim();
    const label = String(item.label || '').trim();
    const href = String(item.href || '').trim();
    const group = String(item.group || 'Other').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || seen.has(id)) throw new Error('navigation item IDs must be unique and use letters, numbers, _ or -');
    if (!label || label.length > 80) throw new Error('navigation labels must contain 1–80 characters');
    if (!safeHref(href)) throw new Error('navigation href must be a safe relative path, section anchor, or HTTP(S) URL');
    if (!group || group.length > 40) throw new Error('navigation group must contain 1–40 characters');
    seen.add(id);
    return {
      id, label, href, group,
      ...(item.section && /^[a-zA-Z0-9_-]{1,40}$/.test(String(item.section)) ? { section: String(item.section) } : {}),
      order: Number.isFinite(Number(item.order)) ? Math.max(-10000, Math.min(10000, Math.trunc(Number(item.order)))) : 1000,
      enabled: item.enabled !== false,
    };
  });
  return { version: 1, updatedAt: new Date().toISOString(), items: items.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)) };
}

function createNavigationConfig(dataDir) {
  const file = path.join(dataDir, 'navigation-config.json');
  function read() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(DEFAULT_NAVIGATION, null, 2) + '\n', { mode: 0o600 });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.items)) throw new Error('navigation config has an invalid format');
    return { version: 1, items: parsed.items.filter((item) => item && typeof item === 'object').sort((a, b) => (a.order || 0) - (b.order || 0)) };
  }
  function replace(input) {
    const validated = validateNavigation(input);
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return validated;
  }
  return { read, replace, file };
}

module.exports = { createNavigationConfig, validateNavigation, safeHref, DEFAULT_NAVIGATION };
