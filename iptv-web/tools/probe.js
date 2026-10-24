'use strict';
// Probe stream health through the running proxy: node tools/probe.js [n] [http|https|all]
const fs = require('fs');
const path = require('path');

const N = parseInt(process.argv[2], 10) || 40;
const KIND = process.argv[3] || 'all';
const BASE = process.env.BASE || 'http://127.0.0.1:3920';

const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'catalog.json'), 'utf8'));
let pool = [];
for (const c of cat.channels) {
  for (const s of c.streams) {
    if (KIND === 'http' && !s.u.startsWith('http:')) continue;
    if (KIND === 'https' && !s.u.startsWith('https:')) continue;
    pool.push({ name: c.name, url: s.u, q: s.q });
  }
}
// spread the sample over the whole list instead of taking the first N (alphabetical bias)
const step = Math.max(1, Math.floor(pool.length / N));
const sample = [];
for (let i = 0; i < pool.length && sample.length < N; i += step) sample.push(pool[i]);

async function one(item) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/hls?u=${encodeURIComponent(item.url)}`, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    const ok = res.ok && /^#EXTM3U/.test(text.trim().slice(0, 20));
    const isMaster = /#EXT-X-STREAM-INF/.test(text);
    return { ok, code: res.status, isMaster, ms: Date.now() - t0, name: item.name, url: item.url };
  } catch (err) {
    return { ok: false, code: 0, ms: Date.now() - t0, name: item.name, url: item.url, err: err.message };
  }
}

(async () => {
  const results = [];
  const CONC = 12;
  for (let i = 0; i < sample.length; i += CONC) {
    results.push(...(await Promise.all(sample.slice(i, i + CONC).map(one))));
  }
  const ok = results.filter((r) => r.ok);
  console.log(`\ntested ${results.length} streams (${KIND}) from ${BASE}`);
  console.log(`playable manifests: ${ok.length} (${((ok.length / results.length) * 100).toFixed(0)}%)`);
  const byCode = {};
  for (const r of results) byCode[r.code] = (byCode[r.code] || 0) + 1;
  console.log('status codes:', JSON.stringify(byCode));
  console.log('\nworking samples:');
  for (const r of ok.slice(0, 12)) console.log(`  ${r.name.slice(0, 28).padEnd(30)} ${r.isMaster ? 'master' : 'media '} ${r.ms}ms  ${r.url.slice(0, 70)}`);
  console.log('\nfailures:');
  for (const r of results.filter((x) => !x.ok).slice(0, 10)) console.log(`  ${String(r.code).padEnd(4)} ${r.name.slice(0, 24).padEnd(26)} ${(r.err || '').slice(0, 50)} ${r.url.slice(0, 60)}`);
})();
