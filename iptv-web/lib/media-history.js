'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_ITEMS = 200;
const TYPES = new Set(['iptv', 'radio', 'theatre']);

function createMediaHistory(dataDir) {
  const file = path.join(dataDir, 'media-history.json');
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(value) ? value.filter(isEntry).slice(0, MAX_ITEMS) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  }
  function isEntry(item) {
    return item && TYPES.has(item.type) && typeof item.id === 'string' &&
      typeof item.title === 'string' && typeof item.playedAt === 'string';
  }
  function write(entries) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(entries) + '\n', { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  function list(type) {
    if (type && !TYPES.has(type)) throw Object.assign(new Error('Invalid media type'), { statusCode: 400 });
    return read().filter((item) => !type || item.type === type);
  }
  function add(input) {
    if (!input || !TYPES.has(input.type)) throw Object.assign(new Error('Invalid media type'), { statusCode: 400 });
    const id = String(input.id || '').trim().slice(0, 180);
    const title = String(input.title || '').trim().slice(0, 180);
    if (!id || !title) throw Object.assign(new Error('A media ID and title are required'), { statusCode: 400 });
    const item = {
      type: input.type,
      id,
      title,
      country: String(input.country || '').trim().slice(0, 80),
      countryCode: String(input.countryCode || '').trim().slice(0, 8),
      playedAt: new Date().toISOString(),
    };
    const entries = read().filter((entry) => !(entry.type === item.type && entry.id === item.id));
    entries.unshift(item);
    write(entries.slice(0, MAX_ITEMS));
    return item;
  }
  function clear(type) {
    if (type && !TYPES.has(type)) throw Object.assign(new Error('Invalid media type'), { statusCode: 400 });
    const entries = read().filter((item) => type && item.type !== type);
    write(entries);
    return entries;
  }
  return { list, add, clear, file, maxItems: MAX_ITEMS };
}
module.exports = { createMediaHistory, MAX_ITEMS, TYPES };
