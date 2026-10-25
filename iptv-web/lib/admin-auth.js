'use strict';
const crypto = require('crypto');
function safeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function matchesAdminCredentials(req, options = {}) {
 const header = String(req && req.headers && req.headers.authorization || '');
 const match = /^Basic\\s+(.+)$/i.exec(header); if (!match) return false;
 let decoded; try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
 const colon = decoded.indexOf(':'); if (colon < 0) return false;
 const username = options.username === undefined ? (process.env.ADMIN_USERNAME || 'admin') : options.username;
 const password = options.password === undefined ? (process.env.ADMIN_PASSWORD || '0809') : options.password;
 return safeEqual(decoded.slice(0, colon), username) && safeEqual(decoded.slice(colon + 1), password);
}
module.exports = { matchesAdminCredentials };
