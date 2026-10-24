'use strict';
// In-process FIFO lock for tiny read-modify-write JSON registries.
// Network requests should happen before acquiring the lock; only reload, validate and commit inside it.
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
module.exports = { withLock };
