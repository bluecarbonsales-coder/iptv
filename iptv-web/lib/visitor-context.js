'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_CATEGORIES = new Set(['live-tv', 'movies', 'series', 'anime', 'documentary', 'radio', 'local-news', 'culture', 'sports', 'education', 'other']);

function normalizeCode(value, max = 32) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);
}

function normalizeContext(input) {
  if (!input || input.consent !== true) throw Object.assign(new Error('explicit consent is required'), { statusCode: 400 });
  const rawCountry = String(input.country || '').trim();
  if (!/^[a-z]{2}$/i.test(rawCountry)) throw Object.assign(new Error('country must be an ISO-style two-letter code'), { statusCode: 400 });
  const country = normalizeCode(rawCountry, 2);
  const region = normalizeCode(input.region, 40);
  const language = normalizeCode(input.language, 16);
  const category = normalizeCode(input.category, 24);
  if (!/^[a-z]{2}$/.test(country)) throw Object.assign(new Error('country must be an ISO-style two-letter code'), { statusCode: 400 });
  if (!language || !ALLOWED_CATEGORIES.has(category)) throw Object.assign(new Error('language and a supported category are required'), { statusCode: 400 });
  return { country, region, language, category };
}

function createVisitorContext(dataDir) {
  const file = path.join(dataDir, 'visitor-resource-trends.json');
  function readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object' ? parsed : { version: 1, days: {} };
    } catch { return { version: 1, days: {} }; }
  }
  function record(input) {
    const context = normalizeContext(input);
    fs.mkdirSync(dataDir, { recursive: true });
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const store = readStore();
    store.days[day] ||= {};
    const key = [context.country, context.region || 'unknown', context.language, context.category].join('|');
    store.days[day][key] = Math.min(1000000, (store.days[day][key] || 0) + 1);
    for (const oldDay of Object.keys(store.days)) if (oldDay < new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)) delete store.days[oldDay];
    const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(store) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true, stored: 'aggregate-only', retentionDays: 30 };
  }
  function trends() {
    const store = readStore();
    const counts = new Map();
    for (const [day, entries] of Object.entries(store.days)) {
      for (const [key, count] of Object.entries(entries || {})) {
        const [country, region, language, category] = key.split('|');
        const id = [country, region, language, category].join('|');
        const item = counts.get(id) || { country, region: region === 'unknown' ? '' : region, language, category, requests: 0, days: new Set() };
        item.requests += Number(count) || 0;
        item.days.add(day);
        counts.set(id, item);
      }
    }
    return Array.from(counts.values())
      .map((item) => ({ ...item, days: item.days.size }))
      .filter((item) => item.requests >= 3)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 100);
  }
  return { record, trends, file };
}

module.exports = { createVisitorContext, normalizeContext, ALLOWED_CATEGORIES };
