(function () {
  'use strict';
  const $ = (sel, root) => (root || document).querySelector(sel);
  const state = {
    query: '', countrycode: '', language: '', tag: '', order: 'clickcount',
    offset: 0, limit: 48, stations: [], favorites: loadJson('radio.favorites', []),
    favoriteStations: loadJson('radio.favoriteStations', []),
    recent: loadJson('radio.recent', []), onlyFavorites: false, activeUuid: '', isLoading: false,
  };
  const grid = $('#stationGrid');
  const audio = $('#radioAudio');
  let hlsPlayer = null;
  let loadSequence = 0;
  let activeTicket = 0;

  function loadJson(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? value : fallback; }
    catch { return fallback; }
  }
  function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function mediaUrl(value) {
    try { const u = new URL(String(value || '')); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; }
    catch { return ''; }
  }
  async function request(url, options) {
    const response = await fetch(url, options || {});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ')');
    return data;
  }
  function flagOrCountry(station) {
    const code = station.countrycode;
    if (code && /^[A-Z]{2}$/.test(code) && code !== 'UN') {
      try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) + ' · ' + code; } catch {}
    }
    return station.country || 'Worldwide';
  }
  function tagsPreview(station) {
    return String(station.tags || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' · ') || 'Community radio';
  }
  function stationById(id) { return state.stations.find((station) => station.stationuuid === id); }
  function isFavorite(id) { return state.favorites.includes(id); }
  function setStatus(message, error) {
    $('#radioStatus').textContent = message || '';
    $('#radioStatus').classList.toggle('error', Boolean(error));
  }
  function updateFavorites() {
    $('#favoriteCount').textContent = String(state.favorites.length);
    $('#showFavorites').setAttribute('aria-pressed', String(state.onlyFavorites));
    $('#showFavorites').classList.toggle('selected', state.onlyFavorites);
  }
  function makeCard(station) {
    const card = document.createElement('article');
    card.className = 'station-card' + (state.activeUuid === station.stationuuid ? ' active' : '');
    card.dataset.uuid = station.stationuuid;
    const avatar = document.createElement('div');
    avatar.className = 'station-avatar';
    avatar.textContent = String(station.name || 'R').trim().slice(0, 1).toUpperCase() || 'R';
    const favicon = mediaUrl(station.favicon);
    if (favicon) {
      const img = document.createElement('img');
      img.src = favicon;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.remove(); }, { once: true });
      avatar.replaceChildren(img);
    }
    const info = document.createElement('div');
    info.className = 'station-info';
    const name = document.createElement('div');
    name.className = 'station-name';
    name.textContent = station.name;
    name.title = station.name;
    const loc = document.createElement('div');
    loc.className = 'station-loc';
    loc.textContent = flagOrCountry(station) + (station.language ? ' · ' + station.language.split(',')[0].trim() : '');
    const tag = document.createElement('div');
    tag.className = 'station-tags';
    tag.textContent = tagsPreview(station);
    const badges = document.createElement('div');
    badges.className = 'station-badges';
    if (station.codec) { const el = document.createElement('span'); el.className = 'station-badge'; el.textContent = station.codec; badges.append(el); }
    if (station.bitrate) { const el = document.createElement('span'); el.className = 'station-badge'; el.textContent = station.bitrate + ' kbps'; badges.append(el); }
    info.append(name, loc, tag, badges);
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = 'station-fav' + (isFavorite(station.stationuuid) ? ' on' : '');
    fav.textContent = isFavorite(station.stationuuid) ? '♥' : '♡';
    fav.setAttribute('aria-label', (isFavorite(station.stationuuid) ? 'Remove from' : 'Add to') + ' favorites');
    fav.title = 'Toggle favorite';
    fav.addEventListener('click', (event) => { event.stopPropagation(); toggleFavorite(station); });
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'station-play';
    play.textContent = state.activeUuid === station.stationuuid && !audio.paused ? 'Ⅱ' : '▶';
    play.setAttribute('aria-label', 'Play ' + station.name);
    play.title = 'Listen';
    play.addEventListener('click', () => playStation(station));
    card.append(avatar, info, fav, play);
    card.addEventListener('dblclick', () => playStation(station));
    return card;
  }
  function render() {
    const favoriteMap = new Map();
    if (state.onlyFavorites) {
      state.favoriteStations.forEach((station) => { if (isFavorite(station.stationuuid)) favoriteMap.set(station.stationuuid, station); });
      state.stations.forEach((station) => { if (isFavorite(station.stationuuid)) favoriteMap.set(station.stationuuid, station); });
    }
    const items = state.onlyFavorites ? [...favoriteMap.values()] : state.stations;
    grid.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'station-empty';
      const glyph = document.createElement('div');
      glyph.className = 'empty-glyph';
      glyph.textContent = '♫';
      const title = document.createElement('strong');
      title.textContent = state.onlyFavorites ? 'No favorites on this page' : 'No stations found';
      const note = document.createElement('span');
      note.textContent = state.onlyFavorites ? 'Favorite a station to collect it here. Search and filter results are separate from this view.' : 'Try a different name, country, language or genre.';
      empty.append(glyph, title, note);
      grid.append(empty);
    } else {
      items.forEach((station) => grid.append(makeCard(station)));
    }
    $('#resultsCount').textContent = String(items.length);
    $('#loadMore').hidden = state.onlyFavorites || state.nextOffset == null || state.stations.length === 0;
    $('#loadMore').disabled = state.isLoading;
    $('#loadMore').textContent = state.isLoading ? 'Loading stations…' : 'Load more stations ↓';
    updateFavorites();
  }
  async function loadStations(reset) {
    if (state.isLoading && !reset) return;
    if (reset) { state.offset = 0; state.nextOffset = null; state.stations = []; }
    state.isLoading = true;
    const currentSequence = ++loadSequence;
    render();
    setStatus(reset ? 'Searching the global radio directory…' : 'Loading more stations…');
    const params = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset), order: state.order, reverse: 'true' });
    if (state.query) params.set('q', state.query);
    if (state.countrycode) params.set('countrycode', state.countrycode);
    if (state.language) params.set('language', state.language);
    if (state.tag) params.set('tag', state.tag);
    try {
      const result = await request('/api/radio/stations?' + params.toString());
      if (currentSequence !== loadSequence) return;
      const incoming = Array.isArray(result.stations) ? result.stations : [];
      if (reset) state.stations = incoming;
      else {
        const existing = new Set(state.stations.map((s) => s.stationuuid));
        state.stations.push(...incoming.filter((s) => !existing.has(s.stationuuid)));
      }
      state.nextOffset = result.nextOffset;
      state.offset = result.nextOffset == null ? state.offset : result.nextOffset;
      setStatus(incoming.length ? 'Directory supplied by Radio Browser. Availability may vary by station and region.' : 'No matches in this result page.');
    } catch (error) {
      setStatus(error.message + ' Check again in a moment.', true);
      if (!state.stations.length) {
        const empty = document.createElement('div');
        empty.className = 'station-empty';
        empty.innerHTML = '<div class="empty-glyph">!</div><strong>Radio directory unavailable</strong><span>' + esc(error.message) + '</span>';
        grid.replaceChildren(empty);
      }
    } finally {
      if (currentSequence === loadSequence) {
        state.isLoading = false;
        render();
      }
    }
  }
  async function loadOptions(type, selectId, defaultLabel) {
    try {
      const result = await request('/api/radio/options?type=' + encodeURIComponent(type));
      const select = $(selectId);
      const values = result.values || [];
      values.forEach((item) => {
        const option = document.createElement('option');
        option.value = type === 'countries' ? item.name.toUpperCase() : item.name;
        const count = item.stationcount ? ' (' + Number(item.stationcount).toLocaleString() + ')' : '';
        let label = item.name;
        if (type === 'countries' && /^[A-Z]{2}$/.test(item.name)) {
          try { label = new Intl.DisplayNames(['en'], { type: 'region' }).of(item.name) + ' · ' + item.name; } catch {}
        }
        option.textContent = label + count;
        select.append(option);
      });
    } catch (error) {
      // Search remains available even if the filter dictionaries are temporarily down.
      console.warn('Could not load radio ' + type + ':', error.message);
    }
  }
  function toggleFavorite(station) {
    if (isFavorite(station.stationuuid)) {
      state.favorites = state.favorites.filter((id) => id !== station.stationuuid);
      state.favoriteStations = state.favoriteStations.filter((item) => item.stationuuid !== station.stationuuid);
    } else {
      state.favorites = [station.stationuuid, ...state.favorites].slice(0, 500);
      state.favoriteStations = [station, ...state.favoriteStations.filter((item) => item.stationuuid !== station.stationuuid)].slice(0, 500);
    }
    saveJson('radio.favorites', state.favorites);
    saveJson('radio.favoriteStations', state.favoriteStations);
    updateFavorites();
    render();
  }
  function setNowPlaying(station) {
    $('#nowPlaying').hidden = false;
    $('#nowName').textContent = station.name;
    $('#nowSub').textContent = [flagOrCountry(station), station.codec, station.bitrate ? station.bitrate + ' kbps' : ''].filter(Boolean).join(' · ');
    $('#nowIcon').textContent = String(station.name || '♫').trim().slice(0, 1).toUpperCase() || '♫';
    document.title = station.name + ' · Open Radio';
    if ('mediaSession' in navigator && 'MediaMetadata' in window) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: station.name,
          artist: flagOrCountry(station),
          album: tagsPreview(station),
        });
        navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        navigator.mediaSession.setActionHandler('stop', () => stopRadio());
      } catch {}
    }
  }
  function destroyHls() {
    if (hlsPlayer) { try { hlsPlayer.destroy(); } catch {} hlsPlayer = null; }
  }
  function clearTrack() {
    activeTicket += 1;
    destroyHls();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.activeUuid = '';
    $('#nowPlaying').hidden = true;
    document.title = 'Public Radio · Service Portal';
    render();
  }
  async function playStation(station) {
    const myTicket = ++activeTicket;
    state.activeUuid = station.stationuuid;
    render();
    setNowPlaying(station);
    $('#nowSub').textContent = 'Resolving station stream…';
    destroyHls();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    try {
      const resolved = await request('/api/radio/resolve/' + encodeURIComponent(station.stationuuid));
      if (myTicket !== activeTicket) return;
      const isHls = station.hls || /\.m3u8(?:$|[?#])/i.test(resolved.url);
      if (isHls && window.Hls && window.Hls.isSupported()) {
        const instance = new window.Hls({ enableWorker: true, maxBufferLength: 30, maxMaxBufferLength: 60 });
        hlsPlayer = instance;
        await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => finish(new Error('Timed out waiting for the radio stream manifest')), 20000);
          function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
          }
          instance.on(window.Hls.Events.MEDIA_ATTACHED, () => {
            if (myTicket !== activeTicket) return finish(new Error('Playback cancelled'));
            instance.loadSource('/hls?u=' + encodeURIComponent(resolved.url));
          });
          instance.on(window.Hls.Events.MANIFEST_PARSED, () => {
            if (myTicket !== activeTicket) return finish(new Error('Playback cancelled'));
            audio.play().then(() => finish(), finish);
          });
          instance.on(window.Hls.Events.ERROR, (event, data) => {
            if (!data.fatal || myTicket !== activeTicket) return;
            finish(new Error('HLS radio stream could not be opened'));
            if (hlsPlayer === instance) destroyHls();
          });
          instance.attachMedia(audio);
        });
      } else {
        const canNativeHls = isHls && audio.canPlayType('application/vnd.apple.mpegurl');
        if (resolved.url.startsWith('http:') && resolved.proxyUrl && !isHls) audio.src = resolved.proxyUrl;
        else audio.src = isHls ? (canNativeHls ? '/hls?u=' + encodeURIComponent(resolved.url) : resolved.url) : resolved.url;
        audio.load();
        await audio.play();
      }
      if (myTicket !== activeTicket) { audio.pause(); return; }
      state.recent = [station.stationuuid, ...state.recent.filter((id) => id !== station.stationuuid)].slice(0, 100);
      saveJson('radio.recent', state.recent);
      render();
      setStatus('Now playing. Streams are provided by their broadcasters; some may be offline or region-restricted.');
    } catch (error) {
      if (myTicket !== activeTicket) return;
      setStatus('Could not start ' + station.name + ': ' + error.message + '. Try another station.', true);
      $('#nowSub').textContent = 'Stream unavailable — choose another station';
    }
  }
  function stopRadio() {
    clearTrack();
    $('#nowName').textContent = 'Radio station';
    $('#nowSub').textContent = 'Choose a station to start listening';
  }
  function bind() {
    let searchTimer = null;
    function setFilter(key, value) {
      state[key] = value;
      $('#quickGenres').querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.tag === state.tag));
      loadStations(true);
    }
    $('#searchButton').addEventListener('click', () => {
      state.query = $('#radioQuery').value.trim();
      loadStations(true);
    });
    $('#radioQuery').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = $('#radioQuery').value.trim();
        loadStations(true);
      }, 420);
    });
    $('#countryFilter').addEventListener('change', (event) => setFilter('countrycode', event.target.value));
    $('#languageFilter').addEventListener('change', (event) => setFilter('language', event.target.value));
    $('#tagFilter').addEventListener('change', (event) => setFilter('tag', event.target.value));
    $('#sortFilter').addEventListener('change', (event) => setFilter('order', event.target.value));
    $('#quickGenres').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tag]');
      if (!button) return;
      const tag = button.dataset.tag;
      state.tag = state.tag === tag ? '' : tag;
      $('#tagFilter').value = state.tag;
      $('#quickGenres').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item.dataset.tag === state.tag));
      loadStations(true);
    });
    $('#showFavorites').addEventListener('click', () => {
      state.onlyFavorites = !state.onlyFavorites;
      render();
    });
    $('#reloadStations').addEventListener('click', () => loadStations(true));
    $('#loadMore').addEventListener('click', () => loadStations(false));
    $('#stopRadio').addEventListener('click', stopRadio);
    audio.addEventListener('play', render);
    audio.addEventListener('pause', render);
    audio.addEventListener('error', () => {
      if (state.activeUuid) {
        $('#nowSub').textContent = 'Playback failed — try another station';
        setStatus('The station stream could not be played. Stream formats and availability vary.', true);
      }
    });
    document.addEventListener('keydown', (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        $('#radioQuery').focus();
      }
      if (event.key === 'Escape' && document.activeElement === $('#radioQuery')) $('#radioQuery').blur();
    });
    $('#nowPlaying').hidden = true;
    $('#nowSub').textContent = 'Choose a station to start listening';
  }
  async function boot() {
    bind();
    await Promise.all([
      loadOptions('countries', '#countryFilter', 'Everywhere'),
      loadOptions('languages', '#languageFilter', 'Any language'),
      loadOptions('tags', '#tagFilter', 'All genres'),
    ]);
    await loadStations(true);
  }
  boot();
})();