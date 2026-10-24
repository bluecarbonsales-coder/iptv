'use strict';
// Minimal M3U / M3U8 (playlist) parser shared by the server and mirrored in the browser.
// Handles #EXTM3U headers, #EXTINF attributes, #EXTVLCOPT referrer/user-agent,
// #KODIPROP, #EXTGRP and #EXTVLCOPT:http-* hints.
// Index of the first comma that is not inside a double-quoted attribute value.
function firstUnquotedComma(s) {
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) return i;
  }
  return -1;
}

function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let pending = null;
  let group = null;
  const KIND = 'playlist';

  const attrs = (s) => {
    const out = {};
    const re = /([A-Za-z0-9_.-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
    const rest = /\s(-?\d+)\s*,\s*(.*)$/.exec(s);
    if (rest) out._duration = rest[1];
    return out;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF:')) {
      const body = line.slice(8);
      const idx = firstUnquotedComma(body);
      const a = attrs(idx >= 0 ? body.slice(0, idx) : body);
      const title = idx >= 0 ? body.slice(idx + 1).trim() : '';
      pending = {
        id: a['tvg-id'] || null,
        name: title || a['tvg-name'] || a['tvg-id'] || null,
        logo: a['tvg-logo'] || null,
        country: a['tvg-country'] || null,
        language: a['tvg-language'] || null,
        group: a['group-title'] || group || null,
        chanNo: a['tvg-chno'] || null,
        kind: KIND,
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

    const vlco = /^#EXTVLCOPT:(.*)$/i.exec(line);
    if (vlco) {
      if (pending) {
        const body = vlco[1];
        const m = /^http-referrer=(.*)$/i.exec(body);
        if (m) pending.referrer = m[1].trim();
        const m2 = /^http-user-agent=(.*)$/i.exec(body);
        if (m2) pending.userAgent = m2[1].trim();
      }
      continue;
    }

    const kodi = /^#KODIPROP:(.*?)=(.*)$/i.exec(line);
    if (kodi && pending) {
      const k = kodi[1].toLowerCase().trim();
      const v = kodi[2].trim();
      if (k.includes('referrer')) pending.referrer = v;
      if (k.includes('user-agent')) pending.userAgent = v;
      if (k.includes('license')) pending.drm = true;
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      pending.url = line;
      if (!pending.name) pending.name = pending.url;
      items.push(pending);
      pending = null;
    } else {
      items.push({
        id: null,
        name: line.split('/').pop(),
        logo: null,
        country: null,
        language: null,
        group: group || null,
        kind: KIND,
        referrer: null,
        userAgent: null,
        url: line,
      });
    }
  }
  return items;
}

// True when a text body looks like an HLS manifest rather than a channel playlist.
function isHlsManifest(text) {
  const head = String(text || '').slice(0, 4000);
  if (!/#EXTM3U/.test(head)) return false;
  return /#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|STREAM-INF|VERSION|KEY|MAP|DISCONTINUITY)/.test(head);
}

module.exports = { parseM3U, isHlsManifest };
