'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const USERNAME_MAX = 128;
const PASSWORD_MAX = 1024;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function validateCredentials(username, password) {
  if (typeof username !== 'string' || username.trim() !== username ||
      username.length < 1 || username.length > USERNAME_MAX || /[\r\n:\x00-\x1f]/.test(username)) {
    const error = new Error('Username must be 1–128 characters and cannot contain colons or control characters.');
    error.statusCode = 400; throw error;
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > PASSWORD_MAX ||
      password.trim() !== password || /[\r\n\x00]/.test(password)) {
    const error = new Error('Password must be at least 12 characters, at most 1024 characters, and have no leading or trailing whitespace.');
    error.statusCode = 400; throw error;
  }
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64, SCRYPT_OPTIONS).toString('hex') };
}
function passwordMatches(password, record) {
  if (!record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
  try { return safeEqual(crypto.scryptSync(password, record.salt, 64, SCRYPT_OPTIONS).toString('hex'), record.hash); }
  catch { return false; }
}
function createAdminAuth(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const file = options.file || path.join(dataDir, 'admin-credentials.json');
  let credentials;
  function save(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(next) + '\n', { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    credentials = next;
  }
  function initialize() {
    if (credentials) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored && stored.version === 1 && typeof stored.username === 'string' &&
          stored.password && typeof stored.password.salt === 'string' && typeof stored.password.hash === 'string') {
        credentials = stored; return;
      }
      throw new Error('Invalid admin credentials file; refusing to overwrite it.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const username = options.username ?? process.env.ADMIN_USERNAME ?? 'admin';
    const password = options.password ?? process.env.ADMIN_PASSWORD ?? '0809';
    validateCredentials(username, password);
    save({ version: 1, username, password: hashPassword(password), updatedAt: new Date().toISOString() });
  }
  initialize();
  function getUsername() { return credentials.username; }
  function matches(username, password) {
    return safeEqual(username, credentials.username) && passwordMatches(password, credentials.password);
  }
  function matchesRequest(req) {
    const header = String(req && req.headers && req.headers.authorization || '');
    const match = /^Basic[ \t]+(.+)$/i.exec(header);
    if (!match) return false;
    let decoded;
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
    const colon = decoded.indexOf(':');
    return colon >= 0 && matches(decoded.slice(0, colon), decoded.slice(colon + 1));
  }
  function update(currentUsername, currentPassword, username, password) {
    if (!matches(currentUsername, currentPassword)) {
      const error = new Error('Current username or password is incorrect.');
      error.statusCode = 401; throw error;
    }
    validateCredentials(username, password);
    save({ version: 1, username, password: hashPassword(password), updatedAt: new Date().toISOString() });
    return { username: credentials.username };
  }
  return { getUsername, matches, matchesRequest, update };
}
module.exports = { createAdminAuth, validateCredentials, hashPassword, passwordMatches };
