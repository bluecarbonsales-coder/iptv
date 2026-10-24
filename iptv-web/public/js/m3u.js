// Browser copy of the M3U parser (mirrors lib/m3u.js so an uploaded file parses locally).
(function (global) {
  'use strict';

  function firstUnquotedComma(s) {
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) return i;
    }
    return -1;
  }

  function attrs(s) {
    const out = {};
    const re = /([A-Za-z0-9_.-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
    return out;
  }

  function parseM3U(text) {
    const items = [];
    let pending = null;
    let group = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTM3U')) continue;

      if (line.startsWith('#EXTINF:')) {
        const body = line.slice(8);
        const idx = firstUnquotedComma(body);
        const a = attrs(idx >= 0 ? body.slice(0, idx) : body);
        const title = idx >= 0 ? body.slice(idx + 1).trim() : '';
        pending = {
          key: a['tvg-id'] || null,
          name: title || a['tvg-name'] || a['tvg-id'] || null,
          logo: a['tvg-logo'] || null,
          group: a['group-title'] || group || null,
          country: a['tvg-country'] || null,
          referrer: null,
          userAgent: null,
          url: null,
        };
        continue;
      }
      if (line.startsWith('#EXTGRP:')) {
        group = line.slice(8).trim();
        if (pending && !pending.group) pending.group = group;
        continue;
      }
      let m = /^#EXTVLCOPT:http-referrer=(.*)$/i.exec(line);
      if (m && pending) { pending.referrer = m[1].trim(); continue; }
      m = /^#EXTVLCOPT:http-user-agent=(.*)$/i.exec(line);
      if (m && pending) { pending.userAgent = m[1].trim(); continue; }
      m = /^#KODIPROP:(.*?)=(.*)$/i.exec(line);
      if (m && pending) {
        const k = m[1].toLowerCase();
        if (k.includes('referrer')) pending.referrer = m[2].trim();
        if (k.includes('user-agent')) pending.userAgent = m[2].trim();
        continue;
      }
      if (line.startsWith('#')) continue;

      if (pending) {
        pending.url = line;
        if (!pending.name) pending.name = line;
        items.push(pending);
        pending = null;
      } else {
        items.push({ key: null, name: line.split('/').pop(), logo: null, group: group, country: null, referrer: null, userAgent: null, url: line });
      }
    }
    return items;
  }

  global.parseM3U = parseM3U;
})(window);
