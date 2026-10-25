/* IPTV Web — browser player for the iptv-org catalogue and any M3U playlist. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const t = (k) => window.I18N.t(k);
  const LS = {
    get(k, dflt) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? dflt : JSON.parse(v);
      } catch {
        return dflt;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };

  const state = {
    view: 'all',
    q: '',
    country: '',
    language: 'eng',
    cats: new Set(),
    minQuality: 0,
    sort: 'name',
    hasLogo: false,
    hideAdult: false,
    page: 1,
    limit: 50,
    total: 0,
    pages: 1,
    items: [],
    meta: null,
    proxy: LS.get('iptvweb.proxy', true),
    favorites: LS.get('iptvweb.fav', []),
    recent: LS.get('iptvweb.recent', []),
    playlists: LS.get('iptvweb.playlists', []),
    vodItems: LS.get('iptvweb.vod.items', []),
    loading: false,
  };

  const favSet = new Set(state.favorites);
  const grid = $('#grid');
  const emptyBox = $('#empty');
  const loadMoreBtn = $('#loadMore');

  /* ------------------------------------------------------------------ utils */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function initials(name) {
    const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
    if (!parts.length) return 'TV';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), ms || 2200);
  }
  function imgUrl(u) {
    return u ? '/img?u=' + encodeURIComponent(u) : null;
  }
  function proxyUrl(src) {
    const p = new URLSearchParams({ u: src.url });
    if (src.referrer) p.set('r', src.referrer);
    if (src.userAgent) p.set('ua', src.userAgent);
    return '/hls?' + p.toString();
  }
  function labelFor(l) {
    if (l === 'Geo-blocked') return t('geo');
    if (l === 'Not 24/7') return t('not24');
    return l;
  }
  function flagFor(code) {
    if (!code) return '';
    const hit = (state.meta && state.meta.countries ? state.meta.countries : []).find((c) => c.code === code);
    return hit ? hit.flag || '' : '';
  }
  function countryLabel(code) {
    if (!code) return '';
    const hit = (state.meta && state.meta.countries ? state.meta.countries : []).find((c) => c.code === code);
    return hit ? hit.name : code;
  }
  function languageLabel(code) {
    if (!code) return '';
    const hit = (state.meta && state.meta.languages ? state.meta.languages : []).find((language) => language.code === code);
    return hit ? hit.name : code.toUpperCase();
  }

  /* ------------------------------------------------------------------ meta */
  async function loadMeta() {
    try {
      const res = await fetch('/api/meta');
      state.meta = await res.json();
      renderMeta();
    } catch (err) {
      $('#metaBlock').textContent = 'API unreachable: ' + err.message;
    }
  }

  function renderMeta() {
    const m = state.meta || {};
    const countrySel = $('#country');
    const cur = state.country;
    countrySel.innerHTML =
      `<option value="">${esc(t('allCountries'))}</option>` +
      (m.countries || [])
        .map((c) => `<option value="${esc(c.code)}">${c.flag || ''} ${esc(c.name)} · ${c.count}</option>`)
        .join('');
    countrySel.value = cur;

    const languageSel = $('#language');
    const languages = m.languages || [];
    if (!languages.some((language) => language.code === state.language) && languages.length && state.language === 'eng') {
      state.language = languages[0].code;
    }
    languageSel.innerHTML = `<option value="">${esc(t('allLanguages'))}</option>` + languages
      .map((language) => `<option value="${esc(language.code)}">${esc(language.name)} · ${language.count}</option>`)
      .join('');
    languageSel.value = state.language;

    const cats = $('#cats');
    const active = state.cats;
    cats.innerHTML = (m.categories || [])
      .map((c) => `<button type="button" class="chip${active.has(c.id) ? ' on' : ''}" data-cat="${esc(c.id)}">${esc(c.name)}<span class="n">${c.count}</span></button>`)
      .join('');
    cats.onclick = (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      const id = b.dataset.cat;
      if (active.has(id)) active.delete(id);
      else active.add(id);
      b.classList.toggle('on');
      applyFilters();
    };

    const upd = m.updated ? new Date(m.updated).toLocaleString() : '—';
    $('#metaBlock').innerHTML = `<div><b>${(m.total || 0).toLocaleString()}</b> ${t('channels')} · <b>${(m.streams || 0).toLocaleString()}</b> streams</div><div>${t('updated')} ${esc(upd)}</div><div>Data © iptv-org (CC0 / MIT)</div>`;
  }

  /* --------------------------------------------------------------- loading */
  function viewIds() {
    if (state.view === 'favorites') return favSet.size ? Array.from(favSet).slice(0, 400) : ['__none__'];
    if (state.view === 'recent') return state.recent.length ? state.recent.slice(0, 400) : ['__none__'];
    return null;
  }

  function getSavedVodForView() {
    const ids = state.view === 'recent' ? state.recent : Array.from(favSet);
    const byId = new Map((state.vodItems || []).map((item) => [item.id, item]));
    return ids.map((id) => byId.get(id)).filter((item) => item && (!state.q || (item.name + ' ' + (item.overview || '')).toLowerCase().includes(state.q.toLowerCase())));
  }

  function buildQuery(page) {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.country) p.set('country', state.country);
    if (state.language) p.set('language', state.language);
    if (state.cats.size) p.set('category', Array.from(state.cats).join(','));
    if (state.minQuality) p.set('minQuality', state.minQuality);
    if (state.hasLogo) p.set('hasLogo', '1');
    if (state.hideAdult) p.set('safe', '1');
    if (state.sort && !state.q) p.set('sort', state.sort);
    p.set('limit', state.limit);
    p.set('page', page);
    const ids = viewIds();
    if (ids) p.set('ids', ids.join(','));
    return p;
  }

  function isVodView(view) {
    return ['movies', 'series', 'anime', 'vod'].includes(view);
  }

  async function load(reset) {
    if (state.view === 'playlists') return renderPlaylistsView();
    if (isVodView(state.view)) return loadVod(reset);
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      if (!state.keepPage) state.page = 1;
      grid.innerHTML = '';
      emptyBox.hidden = true;
    }
    $('#resultCount').textContent = t('loading');
    try {
      const p = buildQuery(state.page);
      const res = await fetch('/api/channels?' + p.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      const extraVod = reset && (state.view === 'favorites' || state.view === 'recent') ? getSavedVodForView() : [];
      const pageItems = (data.items || []).concat(extraVod);
      state.total = data.total + extraVod.length;
      state.pages = data.pages;
      state.items = pageItems;
      renderCards(pageItems, false);
      renderResultBar();
      renderPagination(data.pages || 1);
    } catch (err) {
      $('#resultCount').textContent = '';
      emptyBox.hidden = false;
      emptyBox.textContent = 'Could not load channels: ' + err.message;
    } finally {
      state.loading = false;
      state.keepPage = false;
    }
  }

  async function loadVod(reset) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      if (!state.keepPage) state.page = 1;
      grid.innerHTML = '';
      emptyBox.hidden = true;
    }
    $('#resultCount').textContent = 'Searching VOD resources…';
    try {
      const params = new URLSearchParams({ type: state.view === 'vod' ? 'all' : state.view });
      if (state.q) params.set('q', state.q);
      const res = await fetch('/api/vod?' + params.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      const items = data.items || [];
      const stored = new Map((state.vodItems || []).map((item) => [item.id, item]));
      for (const item of items) stored.set(item.id, item);
      state.vodItems = Array.from(stored.values()).slice(-500);
      LS.set('iptvweb.vod.items', state.vodItems);
      state.total = data.total || items.length;
      state.items = items;
      state.pages = Math.max(1, Math.ceil(items.length / 50));
      state.page = Math.min(state.page, state.pages);
      renderCards(items.slice((state.page - 1) * 50, state.page * 50), false);
      renderPagination(state.pages);
      $('#resultCount').innerHTML = `<b>${state.total.toLocaleString()}</b> ${state.view === 'anime' ? 'anime titles' : state.view === 'series' ? 'series' : state.view === 'movies' ? 'movies' : 'VOD titles'} · page ${state.page} of ${state.pages}`;
      const good = (data.providers || []).filter((provider) => provider.ok).length;
      const failures = (data.errors || []).length;
      const badges = [];
      if (state.q) badges.push(`<span class="af">Search: <b>${esc(state.q)}</b></span>`);
      if (good) badges.push(`<span class="af">${good} provider${good === 1 ? '' : 's'} responded</span>`);
      if (failures) badges.push(`<span class="af">${failures} provider${failures === 1 ? '' : 's'} unavailable</span>`);
      $('#activeFilters').innerHTML = badges.join('');
      loadMoreBtn.hidden = true;
      if (!items.length) {
        emptyBox.hidden = false;
        emptyBox.textContent = data.hint || (failures ? 'No titles returned. Check the provider API URLs and availability in VOD resources.' : 'No titles found. Add an authorized VOD API or try another search.');
      }
      syncHash();
    } catch (err) {
      $('#resultCount').textContent = '';
      emptyBox.hidden = false;
      emptyBox.textContent = 'Could not load VOD resources: ' + err.message;
    } finally {
      state.loading = false;
      state.keepPage = false;
    }
  }

  function renderPagination(pages) {
    const el = $('#channelPagination');
    if (!el) return;
    if (pages <= 1) { el.innerHTML = ''; return; }
    const start = Math.max(1, Math.min(state.page - 2, pages - 4));
    const end = Math.min(pages, start + 4);
    let html = `<button data-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>‹</button>`;
    for (let p = start; p <= end; p++) html += `<button data-page="${p}" class="${p === state.page ? 'active' : ''}" aria-current="${p === state.page ? 'page' : 'false'}">${p}</button>`;
    html += `<button data-page="${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>›</button>`;
    el.innerHTML = html;
  }

  function renderResultBar() {
    const bits = [];
    const n = state.total.toLocaleString();
    $('#resultCount').innerHTML = `<b>${n}</b> ${t('channels')}`;
    if (state.q) bits.push(`<span class="af">🔎 <b>${esc(state.q)}</b></span>`);
    if (state.language) bits.push(`<span class="af">🌐 <b>${esc(languageLabel(state.language))}</b></span>`);
    if (state.country) bits.push(`<span class="af">${flagFor(state.country)} <b>${esc(countryLabel(state.country))}</b></span>`);
    for (const c of state.cats) bits.push(`<span class="af"><b>${esc(c)}</b></span>`);
    if (state.minQuality) bits.push(`<span class="af"><b>${state.minQuality}p+</b></span>`);
    if (state.hasLogo) bits.push(`<span class="af">logo only</span>`);
    $('#activeFilters').innerHTML = bits.join('');
    syncHash();
  }

  function cardHTML(it) {
    if (it.vod) {
      const fav = favSet.has(it.id);
      const poster = imgUrl(it.logo);
      const subtitle = [it.year, it.remarks, it.sourceName].filter(Boolean).join(' · ');
      const recordLink = it.pageUrl ? `<a class="vod-record" href="${esc(it.pageUrl)}" data-vod-page target="_blank" rel="noopener noreferrer">View source / license ↗</a>` : '';
      return `<article class="card vod-card" data-id="${esc(it.id)}" tabindex="0" title="${esc(it.overview || it.name)}">
        <div class="thumb vod-thumb">${poster ? `<img loading="lazy" src="${esc(poster)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ini',textContent:'${esc(initials(it.name))}'}))">` : `<div class="ini">${esc(initials(it.name))}</div>`}</div>
        <div class="meta">
          <div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="sub">${subtitle ? `<span>${esc(subtitle)}</span>` : ''}<span class="badge">${esc(it.kind || 'VOD')}</span></div>
          ${it.overview ? `<div class="vod-overview">${esc(it.overview)}</div>` : ''}
          ${recordLink}
        </div>
        <button class="fav${fav ? ' on' : ''}" data-fav="${esc(it.id)}" title="${t('tabFavorites')}">${fav ? '★' : '☆'}</button>
      </article>`;
    }
    const fav = favSet.has(it.id);
    const logo = imgUrl(it.logo);
    const badges = [];
    if (it.q) badges.push(`<span class="badge q">${esc(it.q)}</span>`);
    if (it.streams > 1) badges.push(`<span class="badge">${it.streams} src</span>`);
    if (it.nsfw) badges.push(`<span class="badge nsfw">${t('adult')}</span>`);
    for (const l of (it.labels || []).slice(0, 1)) badges.push(`<span class="badge dead">${esc(labelFor(l))}</span>`);
    badges.push(`<span class="badge live">live</span>`);
    return `<article class="card" data-id="${esc(it.id)}" tabindex="0">
      <div class="thumb">${logo ? `<img loading="lazy" src="${esc(logo)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ini',textContent:'${esc(initials(it.name))}'}))">` : `<div class="ini">${esc(initials(it.name))}</div>`}</div>
      <div class="meta">
        <div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="sub">${(it.languages || []).length ? `<span>${esc(it.languages.slice(0, 2).map(languageLabel).join(' · '))}</span>` : ''}${it.country ? `<span class="muted">${flagFor(it.country)} ${esc(countryLabel(it.country))}</span>` : ''}${badges.join('')}</div>
      </div>
      <button class="fav${fav ? ' on' : ''}" data-fav="${esc(it.id)}" title="${t('tabFavorites')}">${fav ? '★' : '☆'}</button>
    </article>`;
  }

  function renderCards(items, append) {
    const html = items.map(cardHTML).join('');
    if (append) grid.insertAdjacentHTML('beforeend', html);
    else grid.innerHTML = html;
    emptyBox.hidden = items.length > 0 || append;
    if (!items.length && !append) emptyBox.textContent = t('noResults');
  }

  /* --------------------------------------------------------- playlist view */
  function renderPlaylistsView() {
    const pl = state.playlists.find((p) => String(p.id) === String(state.playlistId));
    if (!pl) {
      grid.innerHTML = '';
      emptyBox.hidden = false;
      emptyBox.innerHTML = `<p>${esc(t('playlistHint'))}</p>`;
      $('#resultCount').textContent = '';
      loadMoreBtn.hidden = true;
      return;
    }
    const items = pl.items;
    state.total = items.length;
    state.items = items;
    renderCards(items, false);
    $('#resultCount').innerHTML = `<b>${items.length.toLocaleString()}</b> ${t('channels')} · ${esc(pl.name)}`;
    $('#activeFilters').innerHTML = pl.url ? `<span class="af">${esc(pl.url.slice(0, 60))}</span>` : '';
    loadMoreBtn.hidden = true;
  }

  function renderPlaylistList() {
    const ul = $('#plList');
    ul.innerHTML = state.playlists
      .map(
        (p) => `<li data-pl="${esc(String(p.id))}">
          <button class="act open" title="Browse">▶</button>
          <span class="nm" title="${esc(p.name)}">${esc(p.name)} <span class="muted">(${p.items.length})</span></span>
          <button class="act del" title="${t('remove')}">✕</button>
        </li>`
      )
      .join('');
  }

  /* ---------------------------------------------------------------- filters */
  function applyFilters() {
    state.page = 1;
    load(true);
  }

  function syncHash() {
    const p = new URLSearchParams();
    if (state.view !== 'all') p.set('v', state.view);
    if (state.q) p.set('q', state.q);
    if (state.country) p.set('c', state.country);
    if (state.language && state.language !== 'eng') p.set('lang', state.language);
    if (state.cats.size) p.set('g', Array.from(state.cats).join(','));
    if (state.minQuality) p.set('q2', state.minQuality);
    if (state.hasLogo) p.set('l', '1');
    if (state.hideAdult) p.set('safe', '1');
    if (state.sort !== 'name') p.set('s', state.sort);
    const h = p.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname);
  }

  function readHash() {
    if (!location.hash) return;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('q')) {
      state.q = p.get('q');
      $('#q').value = state.q;
    }
    if (p.get('c')) state.country = p.get('c');
    if (p.has('lang')) state.language = p.get('lang');
    if (p.get('g')) state.cats = new Set(p.get('g').split(',').filter(Boolean));
    if (p.get('q2')) {
      state.minQuality = parseInt(p.get('q2'), 10) || 0;
      $('#minQuality').value = String(state.minQuality);
    }
    state.hasLogo = p.get('l') === '1';
    state.hideAdult = p.get('safe') === '1';
    if (p.get('s')) {
      state.sort = p.get('s');
      $('#sort').value = state.sort;
    }
    if (p.get('v')) setView(p.get('v'), false);
    $('#optLogo').checked = state.hasLogo;
    $('#optSafe').checked = state.hideAdult;
  }

  function setView(v, reload) {
    if (isVodView(v)) { window.location.href = '/movies.html?section=' + encodeURIComponent(v === 'vod' ? 'all' : v); return; }
    state.view = v;
    $('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    if (v !== 'playlists' || !state.playlistId) state.playlistId = null;
    const vodView = isVodView(v);
    $('#channelFilters').hidden = vodView;
    $('#playlistSide').hidden = vodView;
    $('#resourceManager').hidden = vodView;
    $('#vodManager').hidden = !vodView;
    $('#btnExport').hidden = vodView;
    $('#q').placeholder = vodView ? 'Search movies, series and anime…' : 'Search 10,000+ channels…  (press /)';
    if (reload !== false) load(true);
  }

  /* ----------------------------------------------------------------- player */
  const player = {
    hls: null,
    sources: [],
    index: 0,
    item: null,
    autoTried: 0,
  };

  async function buildSources(item) {
    if (item.vod) {
      const res = await fetch('/api/vod/' + encodeURIComponent(item.sourceId) + '/' + encodeURIComponent(item.vodId));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'VOD details failed to load');
      return (data.episodes || []).map((episode, i) => ({
        url: episode.url,
        title: episode.title || ('Episode ' + (i + 1)),
        quality: null,
        labels: [],
        index: i,
      }));
    }
    if (item.playlist) {
      return [
        {
          url: item.url,
          referrer: item.referrer,
          userAgent: item.userAgent,
          quality: null,
          labels: [],
          title: item.group || 'playlist',
        },
      ];
    }
    const res = await fetch('/api/channel/' + encodeURIComponent(item.id));
    if (!res.ok) throw new Error('channel lookup failed');
    const data = await res.json();
    return (data.streamsList || []).map((s, i) => ({
      url: s.u,
      referrer: s.r,
      userAgent: s.ua,
      quality: s.q,
      labels: s.l || [],
      feed: s.f,
      index: i,
    }));
  }

  async function openPlayer(item) {
    player.item = item;
    player.index = 0;
    player.autoTried = 0;
    $('#player').hidden = false;
    $('#pName').textContent = item.name;
    $('#pSub').textContent = [item.year || null, item.remarks || null, item.sourceName || null, item.country ? countryLabel(item.country) : null, (item.cats || []).join(', ')].filter(Boolean).join(' · ');
    $('#pLogo').hidden = !item.logo;
    if (item.logo) $('#pLogo').src = imgUrl(item.logo);
    $('#pFav').textContent = favSet.has(item.id) ? '★' : '☆';
    $('#pFav').classList.toggle('on', favSet.has(item.id));
    $('#pLabels').innerHTML = '';
    setStatus('');
    showOverlay(t('connecting'), true);

    let sourceError = '';
    try {
      player.sources = await buildSources(item);
    } catch (err) {
      player.sources = [];
      sourceError = err.message || 'source lookup failed';
    }
    if (!player.sources.length) {
      showOverlay(sourceError || t('noSources'), false, true);
      return;
    }
    const sel = $('#pSource');
    sel.innerHTML = player.sources
       .map((s, i) => `<option value="${i}">${i + 1}. ${esc(s.title || s.quality || 'auto')}${s.labels && s.labels.length ? ' · ' + esc(s.labels.join('/')) : ''} — ${esc((s.url || '').slice(0, 58))}</option>`)
      .join('');
    sel.value = '0';
    pushRecent(item.id);
    play(0);
  }

  function closePlayer() {
    destroyHls();
    const v = $('#video');
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {}
    $('#player').hidden = true;
    player.item = null;
  }

  function destroyHls() {
    if (player.hls) {
      try {
        player.hls.destroy();
      } catch {}
      player.hls = null;
    }
  }

  function showOverlay(msg, spin, isErr) {
    const ov = $('#videoOverlay');
    ov.classList.remove('hide');
    $('#spinner').classList.toggle('hide', !spin);
    const el = $('#vmsg');
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
    $('#vRetry').hidden = !isErr;
    $('#vNext').hidden = !isErr || player.sources.length < 2;
  }
  function hideOverlay() {
    $('#videoOverlay').classList.add('hide');
  }
  function setStatus(s) {
    $('#pStatus').textContent = s || '';
  }

  function play(index) {
    const src = player.sources[index];
    if (!src) return;
    player.index = index;
    destroyHls();
    const video = $('#video');
    const relay = $('#pProxy').checked;
    const target = relay ? proxyUrl(src) : src.url;
    $('#pQuality').innerHTML = '<option value="-1">Auto</option>';
    setStatus(src.quality ? `${src.quality} · ${relay ? 'relay' : 'direct'}` : relay ? 'relay' : 'direct');

    if (!relay && /^http:\/\//i.test(src.url) && location.protocol === 'https:') {
      showOverlay('This source is plain HTTP and cannot be played from an HTTPS page directly — switching the relay on.', false, true);
      $('#pProxy').checked = true;
      return play(index);
    }
    if (!relay) showOverlay(t('connecting') + ' (direct — CORS may block this)', true);
    else showOverlay(t('connecting'), true);

    const directFile = /\.(mp4|m4v|webm|mov|ogv|ogg|mp3|aac)(?:$|[?#])/i.test(src.url);
    if (directFile) {
      video.src = target;
      video.onloadeddata = hideOverlay;
      video.onerror = () => onStreamError('direct media playback error');
      video.play().catch(() => {});
      return;
    }

    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') && !window.Hls;
    if (nativeHls) {
      video.src = target;
      video.play().catch(() => {});
      video.onloadeddata = hideOverlay;
      video.onerror = () => onStreamError('native playback error');
      return;
    }
    if (!window.Hls || !window.Hls.isSupported()) {
      showOverlay('This browser cannot play HLS streams (no Media Source Extensions).', false, true);
      return;
    }

    const hls = new window.Hls({
      lowLatencyMode: false,
      enableWorker: true,
      backBufferLength: 30,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 2,
      levelLoadingTimeOut: 12000,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 3,
      maxBufferLength: 24,
    });
    player.hls = hls;

    hls.on(window.Hls.Events.MANIFEST_PARSED, (e, data) => {
      const levels = data.levels || [];
      const opts = ['<option value="-1">Auto</option>']
        .concat(levels.map((l, i) => `<option value="${i}">${l.height ? l.height + 'p' : Math.round((l.bitrate || 0) / 1000) + ' kbps'}</option>`))
        .join('');
      $('#pQuality').innerHTML = opts;
      setStatus(`${levels.length} level${levels.length === 1 ? '' : 's'} · ${$('#pProxy').checked ? 'relay' : 'direct'}`);
      hideOverlay();
      hls.currentLevel = -1;
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (e, data) => {
      const l = hls.levels[data.level];
      if (l && l.height) setStatus(`${l.height}p · ${$('#pProxy').checked ? 'relay' : 'direct'}`);
    });
    hls.on(window.Hls.Events.ERROR, (e, data) => {
      if (!data.fatal) return;
      const map = {
        networkError: 'network error',
        mediaError: 'media error',
        otherError: 'playback error',
      };
      const detail = (data.response && (data.response.code || data.response.text)) || '';
      onStreamError(`${map[data.type] || data.type}${detail ? ' (' + String(detail).slice(0, 120) + ')' : ''}`);
    });

    hls.loadSource(target);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
      video.play().catch(() => {});
    });

    video.onplaying = () => {
      hideOverlay();
      player.autoTried = 0;
    };
  }

  function onStreamError(reason) {
    if (!player.item) return;
    const more = player.sources.length > 1 && player.index < player.sources.length - 1;
    if (more && player.autoTried < player.sources.length) {
      player.autoTried++;
      showOverlay(`${t('errGeneric')} ${reason}. ${t('errNext')}`, true);
      setTimeout(() => {
        const next = (player.index + 1) % player.sources.length;
        $('#pSource').value = String(next);
        play(next);
      }, 1200);
      return;
    }
    showOverlay(`${t('errGeneric')} ${reason}`, false, true);
  }

  function pushRecent(id) {
    state.recent = [id].concat(state.recent.filter((x) => x !== id)).slice(0, 60);
    LS.set('iptvweb.recent', state.recent);
  }

  function toggleFav(id) {
    if (favSet.has(id)) {
      favSet.delete(id);
      toast(t('favRemoved'));
    } else {
      favSet.add(id);
      toast(t('favAdded'));
    }
    LS.set('iptvweb.fav', Array.from(favSet));
    $$('[data-fav="' + CSS.escape(id) + '"]').forEach((b) => {
      b.textContent = favSet.has(id) ? '★' : '☆';
      b.classList.toggle('on', favSet.has(id));
    });
    if (player.item && player.item.id === id) {
      $('#pFav').textContent = favSet.has(id) ? '★' : '☆';
      $('#pFav').classList.toggle('on', favSet.has(id));
    }
    if (state.view === 'favorites') load(true);
  }

  /* ------------------------------------------------------------- playlists */
  async function addPlaylistFromUrl(url) {
    toast('Loading playlist…');
    try {
      const res = await fetch('/api/playlist?u=' + encodeURIComponent(url));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      const pl = {
        id: Date.now(),
        name: (data.source || url).split('/').pop().slice(0, 40) || 'playlist',
        url,
        items: data.items.map((i, n) => ({ id: 'pl' + n, name: i.name || 'Channel ' + n, logo: i.logo, country: i.country, cats: i.group ? [i.group] : [], q: null, streams: 1, labels: [], playlist: true, url: i.url, referrer: i.referrer, userAgent: i.userAgent })),
      };
      state.playlists.unshift(pl);
      LS.set('iptvweb.playlists', state.playlists);
      renderPlaylistList();
      toast(`${t('added')}: ${pl.items.length} ${t('channels')}`);
      state.playlistId = pl.id;
      setView('playlists', true);
    } catch (err) {
      toast(t('importFailed') + ': ' + err.message, 4000);
    }
  }

  function addPlaylistFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const items = window.parseM3U(String(reader.result));
        if (!items.length) throw new Error('no channels found');
        const pl = {
          id: Date.now(),
          name: file.name.slice(0, 40),
          url: null,
          items: items.map((i, n) => ({ id: 'pl' + n, name: i.name || 'Channel ' + n, logo: i.logo, country: i.country, cats: i.group ? [i.group] : [], q: null, streams: 1, labels: [], playlist: true, url: i.url, referrer: i.referrer, userAgent: i.userAgent })),
        };
        state.playlists.unshift(pl);
        LS.set('iptvweb.playlists', state.playlists);
        renderPlaylistList();
        toast(`${t('added')}: ${pl.items.length} ${t('channels')}`);
        state.playlistId = pl.id;
        setView('playlists', true);
      } catch (err) {
        toast(t('importFailed') + ': ' + err.message, 4000);
      }
    };
    reader.readAsText(file);
  }

  /* ------------------------------------------------------------------ wiring */
  function onGridClick(e) {
    if (e.target.closest('[data-vod-page]')) return;
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) {
      e.stopPropagation();
      toggleFav(favBtn.dataset.fav);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const item = state.items.find((x) => x.id === id) || (state.view === 'playlists' ? state.items.find((x) => x.id === id) : null);
    if (!item) return;
    openPlayer(item);
  }

  function initEvents() {
    grid.addEventListener('click', onGridClick);
    grid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.classList.contains('card')) openPlayer(state.items.find((x) => x.id === e.target.dataset.id));
    });

    $('#searchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      state.q = $('#q').value.trim();
      applyFilters();
    });
    let deb;
    $('#q').addEventListener('input', () => {
      $('#clearSearch').hidden = !$('#q').value;
      clearTimeout(deb);
      deb = setTimeout(() => {
        state.q = $('#q').value.trim();
        applyFilters();
      }, isVodView(state.view) ? 500 : 280);
    });
    $('#clearSearch').onclick = () => {
      $('#q').value = '';
      state.q = '';
      $('#clearSearch').hidden = true;
      applyFilters();
    };

    $('.tab').forEach((b) =>
      b.addEventListener('click', () => {
        state.playlistId = null;
        setView(b.dataset.view, true);
      })
    );
    $('#mobileView').addEventListener('change', (e) => {
      state.playlistId = null;
      setView(e.target.value, true);
    });

    $('#country').addEventListener('change', (e) => {
      state.country = e.target.value;
      applyFilters();
    });
    $('#language').addEventListener('change', (e) => {
      state.language = e.target.value;
      applyFilters();
    });
    $('#countrySearch').addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      $$('#country option').forEach((o) => {
        if (!o.value) return;
        o.hidden = term && !o.textContent.toLowerCase().includes(term);
      });
    });
    $('#sort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      applyFilters();
    });
    $('#minQuality').addEventListener('change', (e) => {
      state.minQuality = parseInt(e.target.value, 10) || 0;
      applyFilters();
    });
    $('#optLogo').addEventListener('change', (e) => {
      state.hasLogo = e.target.checked;
      applyFilters();
    });
    $('#optSafe').addEventListener('change', (e) => {
      state.hideAdult = e.target.checked;
      applyFilters();
    });
    $('#resetFilters').onclick = () => {
      state.q = '';
      state.country = '';
      state.language = 'eng';
      state.cats.clear();
      state.minQuality = 0;
      state.hasLogo = false;
      state.sort = 'name';
      $('#q').value = '';
      $('#country').value = '';
      $('#language').value = 'eng';
      $('#minQuality').value = '0';
      $('#sort').value = 'name';
      $('#optLogo').checked = false;
      $$('#cats .chip').forEach((c) => c.classList.remove('on'));
      applyFilters();
    };

    $('#optProxy').addEventListener('change', (e) => {
      state.proxy = e.target.checked;
      LS.set('iptvweb.proxy', state.proxy);
      $('#pProxy').checked = state.proxy;
      updateProxyNote();
    });
    $('#pProxy').addEventListener('change', (e) => {
      state.proxy = e.target.checked;
      LS.set('iptvweb.proxy', state.proxy);
      $('#optProxy').checked = state.proxy;
      updateProxyNote();
      play(player.index);
    });

    $('#channelPagination').addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (!button || button.disabled || state.loading) return;
      const target = Number(button.dataset.page);
      if (!Number.isInteger(target) || target < 1 || target > state.pages) return;
      state.page = target;
      state.keepPage = true;
      load(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    loadMoreBtn.hidden = true;

    // Catalogue paging is explicit: visitors choose a numbered page.

    $('#btnFilters').onclick = () => {
      const sb = $('#sidebar');
      const opening = !sb.classList.contains('open');
      sb.classList.toggle('open', opening);
      $('#scrim').hidden = !opening;
    };
    $('#scrim').onclick = () => {
      $('#sidebar').classList.remove('open');
      $('#scrim').hidden = true;
    };
    $('#btnLang').onclick = (e) => {
      const l = window.I18N.toggle();
      e.currentTarget.textContent = l === 'en' ? 'EN' : '中文';
      renderResultBar();
      renderPlaylistList();
      updateProxyNote();
      if (state.view === 'playlists') renderPlaylistsView();
    };
    $('#btnExport').addEventListener('click', (e) => {
      const p = buildQuery(1);
      p.delete('page');
      p.delete('limit');
      e.currentTarget.href = '/api/export.m3u?' + p.toString();
    });

    $('#plAdd').onclick = () => {
      const url = $('#plUrl').value.trim();
      if (!url) return toast('Enter a playlist URL first');
      addPlaylistFromUrl(url);
    };
    $('#plFile').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) addPlaylistFromFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#plList').addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      const id = li.dataset.pl;
      if (e.target.classList.contains('del')) {
        state.playlists = state.playlists.filter((p) => String(p.id) !== String(id));
        LS.set('iptvweb.playlists', state.playlists);
        renderPlaylistList();
        if (String(state.playlistId) === String(id)) {
          state.playlistId = null;
          renderPlaylistsView();
        }
        return;
      }
      state.playlistId = id;
      setView('playlists', true);
    });

    // Persistent source management lives in /admin.html; it uses a simple username/password login.

    // player wiring
    $('#pClose').onclick = closePlayer;
    $('#pFav').onclick = () => player.item && toggleFav(player.item.id);
    $('#pReload').onclick = () => play(player.index);
    $('#pCopy').onclick = async () => {
      const src = player.sources[player.index];
      if (!src) return;
      const url = $('#pProxy').checked ? location.origin + proxyUrl(src) : src.url;
      try {
        await navigator.clipboard.writeText(url);
        toast(t('copied'));
      } catch {
        prompt('Stream URL', url);
      }
    };
    $('#pSource').addEventListener('change', (e) => play(parseInt(e.target.value, 10) || 0));
    $('#pQuality').addEventListener('change', (e) => {
      if (player.hls) {
        const v = parseInt(e.target.value, 10);
        player.hls.currentLevel = v;
      }
    });
    $('#vRetry').onclick = () => play(player.index);
    $('#vNext').onclick = () => play((player.index + 1) % player.sources.length);

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        $('#q').focus();
      }
      if (e.key === 'Escape') {
        if (!$('#player').hidden) closePlayer();
        else {
          $('#sidebar').classList.remove('open');
          $('#scrim').hidden = true;
        }
      }
      if (!$('#player').hidden && !typing) {
        const v = $('#video');
        if (e.key === ' ') {
          e.preventDefault();
          v.paused ? v.play() : v.pause();
        }
        if (e.key === 'f') {
          if (document.fullscreenElement) document.exitFullscreen();
          else $('#videoWrap').requestFullscreen && $('#videoWrap').requestFullscreen();
        }
      }
    });
    $('#player').addEventListener('click', (e) => {
      if (e.target.id === 'player') closePlayer();
    });
  }

  function updateProxyNote() {
    $('#proxyNote').textContent = state.proxy ? t('proxyOn') : t('proxyOff');
  }

  /* -------------------------------------------------------------------- boot */
  function boot() {
    $('#optProxy').checked = state.proxy;
    $('#pProxy').checked = state.proxy;
    $('#btnLang').textContent = window.I18N.lang === 'en' ? 'EN' : '中文';
    window.I18N.apply();
    updateProxyNote();
    readHash();
    renderPlaylistList();
    initEvents();
    loadMeta().then(() => {
      renderMeta();
      load(true);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
