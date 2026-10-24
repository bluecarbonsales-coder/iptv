'use strict';
// In-process FIFO lock for read-modify-write JSON registries.
const fs = require('fs');
const path = require('path');
const tails = new Map();

async function withLock(key, fn) {
  const lockKey = String(key);
  const previous = tails.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  tails.set(lockKey, current);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(lockKey) === current) tails.delete(lockKey);
  }
}

// Cross-process advisory lock for JSON files that are also written by refresh.js child processes.
// Keep the locked callback short: never perform network I/O while holding this lock.
async function withFileLock(lockPath, fn, timeoutMs = 15000) {
  const target = path.resolve(String(lockPath));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.promises.open(target, 'wx', 0o600);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const stat = await fs.promises.stat(target);
        // Recover only from stale locks, never simply bypass a live writer.
        if (Date.now() - stat.mtimeMs > 120000) {
          await fs.promises.unlink(target);
          continue;
        }
      } catch (statErr) {
        if (statErr && statErr.code === 'ENOENT') continue;
        throw statErr;
      }
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(new Error('timed out waiting for registry lock'), { statusCode: 503 });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch {}
    try { await fs.promises.unlink(target); } catch {}
  }
}

module.exports = { withLock, withFileLock };
