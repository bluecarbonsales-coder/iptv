'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = new Set(['iptv', 'radio', 'theatre']);
const MAX_ITEMS = 500;
function createAccountHistory(dataDir) {
  const file = path.join(dataDir, 'account-media-history.json');
  function read() {
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  function list(type) {
    if (type && !TYPES.has(type)) throw Object.assign(new Error('type must be iptv, radio, or theatre'), { statusCode: 400 });
    const all = read();
    const rows = Array.isArray(all.owner) ? all.owner : [];
    return rows.filter(item => (!type || item.type === type) && Date.now() - Date.parse(item.updatedAt) < 365 * 86400000);
  }
  function record(body) {
    if (!body || !TYPES.has(body.type) || !['watch', 'listen'].includes(body.action)) throw Object.assign(new Error('type/action is invalid'), { statusCode: 400 });
    if ((body.type === 'radio' && body.action !== 'listen') || (body.type !== 'radio' && body.action !== 'watch')) throw Object.assign(new Error('action does not match media type'), { statusCode: 400 });
    const title = String(body.title || '').trim().slice(0, 240);
    const id = String(body.itemId || '').trim().slice(0, 300);
    if (!title || !id) throw Object.assign(new Error('title and itemId are required'), { statusCode: 400 });
    const all = read();
    const rows = Array.isArray(all.owner) ? all.owner : [];
    const item = {
      id: crypto.randomUUID(), type: body.type, action: body.action, itemId: id, title,
      subtitle: String(body.subtitle || '').slice(0, 240),
      image: typeof body.image === 'string' && /^https?:\/\//i.test(body.image) ? body.image.slice(0, 1500) : '',
      url: typeof body.url === 'string' ? body.url.slice(0, 1200) : '',
      position: Number.isFinite(Number(body.position)) ? Math.max(0, Math.min(86400, Number(body.position))) : 0,
      updatedAt: new Date().toISOString(),
    };
    const index = rows.findIndex(row => row.type === item.type && row.itemId === item.itemId);
    if (index >= 0) rows.splice(index, 1);
    rows.unshift(item);
    all.owner = rows.slice(0, MAX_ITEMS);
    write(all);
    return { ok: true, item: all.owner[0] };
  }
  return { list, record };
}
module.exports = { createAccountHistory };
