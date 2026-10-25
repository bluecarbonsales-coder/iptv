(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const state = { auth: '', active: 'radio', sourceLists: { radio: [], iptv: [], theatre: [] }, sourceHealth: Object.create(null), directLatency: Object.create(null), healthTimer: null, directRunning: false };
  const routes = {
    radio: '/admin/api/radio/sources',
    iptv: '/admin/api/iptv/sources',
    theatre: '/admin/api/theatre/sources',
  };
  const labels = { radio: 'Radio', iptv: 'IPTV', theatre: 'Theatre' };
  const healthKey = (section, id) => section + ':' + id;
  const healthLabels = { online: 'Available', slow: 'Available · slow', restricted: 'Restricted', not_found: 'Not found', offline: 'Offline', unavailable: 'Unavailable', unknown: 'Unknown', checking: 'Checking…', disabled: 'Disabled' };
  function renderHealthSummary(summary) {
    const root = $('#sourceHealthSummary'); if (!root) return;
    root.replaceChildren();
    for (const section of ['all', 'radio', 'iptv', 'theatre']) {
      const data = summary && summary[section]; if (!data) continue;
      const card = make('div', 'health-card');
      card.append(make('h3', '', section === 'all' ? 'All sources' : labels[section] + ' sources'));
      card.append(make('div', 'health-count', data.available + ' available / ' + data.enabled + ' enabled'));
      card.append(make('div', 'health-detail', data.unavailable + ' unavailable · ' + data.checking + ' checking · ' + data.disabled + ' disabled'));
      root.append(card);
    }
  }
  function renderSourceHealthLine(section, source) {
    const key = healthKey(section, source.id), h = state.sourceHealth[key], network = state.directLatency[key];
    const relay = h ? 'Server / relay: ' + (healthLabels[h.status] || h.status) +
      (Number.isFinite(h.proxyLatencyMs) ? ' · ' + h.proxyLatencyMs + ' ms' : '') + (h.httpStatus ? ' · HTTP ' + h.httpStatus : '')
      : (source.enabled === false ? 'Server / relay: disabled' : 'Server / relay: checking…');
    const direct = network ? 'Current network: ' + (Number.isFinite(network.latencyMs) ? network.latencyMs + ' ms RTT' : network.status)
      : (source.enabled === false ? 'Current network: disabled' : 'Current network: not measured yet');
    return { relay, direct };
  }
  const status = (section, message, error = false) => {
    const el = $('#' + section + 'Status');
    el.textContent = message || '';
    el.classList.toggle('error', !!error);
  };
  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.auth) headers.Authorization = 'Basic ' + state.auth;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      state.auth = '';
      $('#manager').hidden = true;
      $('#loginPanel').hidden = false;
      throw new Error('Login expired. Please sign in again.');
    }
    if (!response.ok) throw new Error(data.error || ('Request failed: HTTP ' + response.status));
    return data;
  }
  function make(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  }
  function renderList(section, sources) {
    const root = $('#' + section + 'List');
    root.replaceChildren();
    if (!sources.length) {
      root.append(make('p', 'note', 'No sources yet. Add one above.'));
      return;
    }
    for (const source of sources) {
      const row = make('div', 'source');
      const main = make('div', 'source-main');
      main.append(make('div', 'source-name', source.name || 'Unnamed source'));
      if (source.url || source.api) main.append(make('div', 'source-url', source.url || source.api));
      let detail = '';
      if (section === 'radio') {
        if (source.type === 'directory') detail = source.enabled ? 'Built-in directory · enabled' : 'Built-in directory · disabled';
        else detail = [source.language, source.country, source.genre, source.enabled ? 'enabled' : 'disabled'].filter(Boolean).join(' · ');
      } else if (section === 'iptv') {
        detail = source.error ? 'Error: ' + source.error : ((source.count || 0) + ' channels · ' + (source.streams || 0) + ' streams');
        detail += source.enabled ? ' · enabled' : ' · disabled';
      } else {
        const kind = ({ all: 'All content', movies: 'Movies', series: 'TV series', anime: 'Anime', documentary: 'Documentaries' })[source.kind] || 'All content';
        detail = kind + (source.lastError ? ' · Error: ' + source.lastError : source.lastChecked ? ' · checked' : ' · not checked yet');
        detail += source.enabled ? ' · enabled' : ' · disabled';
      }
      main.append(make('div', 'source-meta', detail));
      const healthLines = renderSourceHealthLine(section, source);
      main.append(make('div', 'source-health', healthLines.relay));
      main.append(make('div', 'source-health', healthLines.direct));
      row.append(main);
      const actions = make('div', 'source-actions');
      const toggle = make('button', '', source.enabled ? 'Disable' : 'Enable');
      toggle.type = 'button';
      toggle.dataset.action = 'toggle';
      toggle.dataset.section = section;
      toggle.dataset.id = source.id;
      toggle.dataset.enabled = String(!source.enabled);
      actions.append(toggle);
      if (!(section === 'radio' && source.id === 'radio-browser')) {
        const remove = make('button', 'danger', 'Delete');
        remove.type = 'button';
        remove.dataset.action = 'delete';
        remove.dataset.section = section;
        remove.dataset.id = source.id;
        actions.append(remove);
      }
      row.append(actions);
      root.append(row);
    }
  }
  async function load(section) {
    status(section, 'Loading ' + labels[section].toLowerCase() + ' sources…');
    try {
      const data = await request(routes[section]);
      const sources = Array.isArray(data.sources) ? data.sources : [];
      state.sourceLists[section] = sources;
      renderList(section, sources);
      status(section, sources.length + ' source(s).');
      void loadHealth(false);
    } catch (error) {
      status(section, error.message, true);
    }
  }
  async function loadHealth(force = false) {
    try {
      const response = await request('/api/v1/sources/health' + (force ? '?refresh=1' : ''));
      state.sourceHealth = Object.create(null);
      for (const item of response.statuses || []) state.sourceHealth[healthKey(item.type, item.id)] = item;
      renderHealthSummary(response.summary || {});
      for (const section of ['radio', 'iptv', 'theatre']) renderList(section, state.sourceLists[section] || []);
      const node = $('#sourceHealthStatus');
      node.classList.remove('error');
      node.textContent = response.scanning ? 'Health checks are running on the server; this panel will update automatically.'
        : 'Last server scan: ' + (response.scanCompletedAt ? new Date(response.scanCompletedAt).toLocaleString() : 'not completed') + '. Latency is response time, not video throughput.';
      if (state.healthTimer) clearTimeout(state.healthTimer);
      if (response.scanning) state.healthTimer = setTimeout(() => loadHealth(false), 2200);
    } catch (error) {
      $('#sourceHealthStatus').textContent = error.message;
      $('#sourceHealthStatus').classList.add('error');
    }
  }

  async function measureNetworkForSource(section, source) {
    const key = healthKey(section, source.id);
    if (source.enabled === false) { state.directLatency[key] = { status: 'disabled', latencyMs: null }; return; }
    let target;
    try { const parsed = new URL(source.url || source.api); target = parsed.origin + '/'; }
    catch { state.directLatency[key] = { status: 'no HTTP(S) URL', latencyMs: null }; renderList(section, state.sourceLists[section] || []); return; }
    const controller = new AbortController(), started = performance.now();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      await fetch(target, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      state.directLatency[key] = { status: 'measured', latencyMs: Math.max(0, Math.round(performance.now() - started)), checkedAt: Date.now() };
    } catch (error) {
      state.directLatency[key] = { status: error && error.name === 'AbortError' ? 'timeout' : 'blocked by browser/network', latencyMs: null, checkedAt: Date.now() };
    } finally { clearTimeout(timer); renderList(section, state.sourceLists[section] || []); }
  }

  async function measureAllNetworkLatencies() {
    if (state.directRunning) return;
    state.directRunning = true;
    const button = $('#checkAllSources'); button.disabled = true;
    $('#sourceHealthStatus').textContent = 'Checking browser RTT to each enabled source host…';
    try {
      const tasks = ['radio', 'iptv', 'theatre'].flatMap(section => (state.sourceLists[section] || [])
        .filter(source => source.enabled !== false).map(source => ({ section, source })));
      let cursor = 0; const concurrency = Math.min(12, tasks.length);
      async function worker() {
        while (cursor < tasks.length) { const item = tasks[cursor++]; await measureNetworkForSource(item.section, item.source); }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      $('#sourceHealthStatus').textContent = 'Browser RTT check finished. Blocked checks are a browser/source restriction, not proof the source is offline; server relay checks are shown separately.';
    } finally { state.directRunning = false; button.disabled = false; }
  }

  async function loadMediaSettings() {
    try {
      const data = await request('/api/v1/settings/media');
      $('#defaultProxy').checked = data.defaultProxy !== false;
      $('#mediaSettingsStatus').textContent = 'Current default: ' + ($('#defaultProxy').checked ? 'server relay on' : 'direct playback preferred') + '.';
      $('#mediaSettingsStatus').classList.remove('error');
    } catch (error) { $('#mediaSettingsStatus').textContent = error.message; $('#mediaSettingsStatus').classList.add('error'); }
  }

  async function mutateThenReload(section, url, options, message) {
    status(section, message || 'Saving changes…');
    try {
      await request(url, options);
      await load(section);
    } catch (error) {
      status(section, error.message, true);
    }
  }
  function setTab(section) {
    state.active = section;
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const active = button.dataset.tab === section;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('.section').forEach((node) => { node.hidden = node.id !== section + 'Section'; });
    if (section === 'api') loadApiIndex();
  }

  function renderApiGroups(groups) {
    const root = $('#apiEndpointGroups');
    root.replaceChildren();
    for (const group of groups || []) {
      const details = make('details', 'api-group');
      details.style.cssText = 'border-top:1px solid var(--line);padding:12px 0';
      const summary = make('summary', '', group.name + ' (' + (group.endpoints || []).length + ')');
      summary.style.cssText = 'cursor:pointer;font-weight:800;padding:6px 0';
      details.append(summary);
      for (const endpoint of group.endpoints || []) {
        const row = make('div', 'source');
        row.style.alignItems = 'flex-start';
        const info = make('div', 'source-main');
        const headline = make('div', 'source-name');
        const method = make('span', '', endpoint.method);
        method.style.cssText = 'display:inline-block;min-width:58px;margin-right:8px;color:var(--accent);font-size:12px;letter-spacing:.05em';
        headline.append(method, document.createTextNode(endpoint.path));
        info.append(headline, make('div', 'source-meta', endpoint.summary + ' · ' + endpoint.auth + ' access'));
        const select = make('button', '', 'Use');
        select.type = 'button';
        select.addEventListener('click', () => {
          let requestPath = endpoint.path;
          for (const match of [...requestPath.matchAll(/\{([^}]+)\}/g)]) {
            const parameter = match[1];
            const defaultValue = parameter === 'type' ? 'radio' : parameter === 'visitorId' ? 'demo-visitor' : parameter === 'sourceId' ? 'archive' : parameter === 'number' ? '1' : '';
            const value = window.prompt('Enter ' + parameter + ' for this endpoint:', defaultValue);
            if (value === null) return;
            if (!value.trim()) {
              $('#apiRequestStatus').textContent = 'A value for ' + parameter + ' is required.';
              $('#apiRequestStatus').classList.add('error');
              return;
            }
            requestPath = requestPath.replace('{' + parameter + '}', encodeURIComponent(value.trim()));
          }
          $('#apiMethod').value = endpoint.method;
          $('#apiPath').value = requestPath;
          if (['POST', 'PATCH', 'PUT'].includes(endpoint.method)) {
            if (requestPath === '/api/v1/sources/radio') $('#apiBody').value = JSON.stringify({ name: 'Example Radio', url: 'https://radio.example/stream.mp3', language: 'English' }, null, 2);
            else if (requestPath === '/api/v1/sources/iptv') $('#apiBody').value = JSON.stringify({ name: 'My IPTV playlist', url: 'https://example.com/playlist.m3u' }, null, 2);
            else if (requestPath === '/api/v1/settings/media') $('#apiBody').value = JSON.stringify({ defaultProxy: true }, null, 2);
            else if (requestPath === '/api/v1/sources/theatre') $('#apiBody').value = JSON.stringify({ name: 'My Theatre provider', api: 'https://example.com/api.php/provide/vod', kind: 'all' }, null, 2);
            else if (!$('#apiBody').value.trim()) $('#apiBody').value = '{}';
          }
          $('#apiTryForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        const actions = make('div', 'source-actions');
        actions.append(select);
        row.append(info, actions);
        details.append(row);
      }
      root.append(details);
    }
  }

  async function loadApiIndex() {
    const statusNode = $('#apiIndexStatus');
    if (!statusNode) return;
    statusNode.textContent = 'Loading platform API…';
    try {
      const response = await fetch('/api/v1', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
      $('#apiBaseUrl').value = data.basePath || '/api/v1';
      $('#apiDocsUrl').value = data.openapi || '/api/v1/openapi.json';
      $('#fullApiBase').textContent = location.origin + (data.basePath || '/api/v1');
      renderApiGroups(data.groups || []);
      statusNode.textContent = (data.groups || []).length + ' endpoint groups loaded. One base path: ' + location.origin + (data.basePath || '/api/v1');
    } catch (error) {
      statusNode.textContent = 'Could not load API list: ' + error.message;
      statusNode.classList.add('error');
    }
  }

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;
    state.auth = btoa(username + ':' + password);
    $('#loginStatus').textContent = 'Checking login…';
    $('#loginStatus').classList.remove('error');
    try {
      await request('/admin/api/check');
      $('#loginPanel').hidden = true;
      $('#manager').hidden = false;
      $('#password').value = '';
      for (const section of Object.keys(routes)) load(section);
      loadApiIndex();
      loadHealth(false);
      loadMediaSettings();
    } catch (error) {
      state.auth = '';
      $('#loginStatus').textContent = 'Login failed: ' + error.message;
      $('#loginStatus').classList.add('error');
    }
  });
  $('#logout').addEventListener('click', () => {
    state.auth = '';
    $('#manager').hidden = true;
    $('#loginPanel').hidden = false;
    $('#password').value = '';
    $('#loginStatus').textContent = 'Signed out.';
  });
  $('#copyApiBase').addEventListener('click', async () => {
    const base = location.origin + '/api/v1';
    try {
      await navigator.clipboard.writeText(base);
      $('#apiIndexStatus').textContent = 'Copied: ' + base;
      $('#apiIndexStatus').classList.remove('error');
    } catch {
      $('#apiBaseUrl').value = base;
      $('#apiBaseUrl').select();
      $('#apiIndexStatus').textContent = 'Select and copy the base URL above.';
    }
  });
  $('#reloadApiIndex').addEventListener('click', loadApiIndex);
  $('#checkAllSources').addEventListener('click', async () => {
    await Promise.all(['radio', 'iptv', 'theatre'].map(section => load(section)));
    await loadHealth(true);
    await measureAllNetworkLatencies();
  });
  $('#saveMediaSettings').addEventListener('click', async () => {
    const button = $('#saveMediaSettings'); button.disabled = true;
    $('#mediaSettingsStatus').textContent = 'Saving playback defaults…';
    $('#mediaSettingsStatus').classList.remove('error');
    try {
      const data = await request('/api/v1/settings/media', { method: 'PUT', body: JSON.stringify({ defaultProxy: $('#defaultProxy').checked }) });
      $('#mediaSettingsStatus').textContent = 'Saved. New page loads will use ' + (data.defaultProxy ? 'server relay' : 'direct playback') + ' by default.';
    } catch (error) {
      $('#mediaSettingsStatus').textContent = error.message; $('#mediaSettingsStatus').classList.add('error');
    } finally { button.disabled = false; }
  });
  $('#clearApiResponse').addEventListener('click', () => {
    $('#apiResponse').textContent = 'API response will appear here.';
    $('#apiRequestStatus').textContent = '';
  });
  $('#apiTryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const method = $('#apiMethod').value.toUpperCase();
    const rawPath = $('#apiPath').value.trim();
    let target;
    try { target = new URL(rawPath, location.origin); }
    catch { $('#apiRequestStatus').textContent = 'Enter a valid API path.'; $('#apiRequestStatus').classList.add('error'); return; }
    if (target.origin !== location.origin || (target.pathname !== '/api/v1' && !target.pathname.startsWith('/api/v1/'))) {
      $('#apiRequestStatus').textContent = 'Use an endpoint on this site under /api/v1.';
      $('#apiRequestStatus').classList.add('error');
      return;
    }
    const headers = {};
    if (state.auth) headers.Authorization = 'Basic ' + state.auth;
    const bodyText = $('#apiBody').value.trim();
    let body;
    if (['POST', 'PATCH', 'PUT'].includes(method) && bodyText) {
      try { body = JSON.stringify(JSON.parse(bodyText)); }
      catch { $('#apiRequestStatus').textContent = 'The request body is not valid JSON.'; $('#apiRequestStatus').classList.add('error'); return; }
      headers['Content-Type'] = 'application/json';
    }
    $('#runApiRequest').disabled = true;
    $('#apiRequestStatus').textContent = 'Sending ' + method + ' ' + target.pathname + '…';
    $('#apiRequestStatus').classList.remove('error');
    $('#apiResponse').textContent = 'Waiting for response…';
    try {
      const started = performance.now();
      const response = await fetch(target.pathname + target.search, { method, headers, body, cache: 'no-store' });
      const raw = await response.text();
      let formatted = raw;
      try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
      $('#apiResponse').textContent = formatted || '(empty response)';
      $('#apiRequestStatus').textContent = 'HTTP ' + response.status + ' · ' + Math.round(performance.now() - started) + ' ms';
      if (!response.ok) $('#apiRequestStatus').classList.add('error');
      if (response.status === 401) {
        state.auth = '';
        $('#manager').hidden = true;
        $('#loginPanel').hidden = false;
        $('#loginStatus').textContent = 'Admin login expired. Please sign in again.';
      }
    } catch (error) {
      $('#apiRequestStatus').textContent = 'Request failed: ' + error.message;
      $('#apiRequestStatus').classList.add('error');
      $('#apiResponse').textContent = String(error);
    } finally {
      $('#runApiRequest').disabled = false;
    }
  });
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));
  document.querySelectorAll('[data-reload]').forEach((button) => button.addEventListener('click', () => load(button.dataset.reload)));

  document.querySelectorAll('[data-enable-all]').forEach((button) => button.addEventListener('click', async () => {
    const section = button.dataset.enableAll;
    const url = section === 'radio' ? routes.radio + '/enable-all'
      : section === 'iptv' ? routes.iptv + '/enable-all'
        : routes.theatre + '/enable-all';
    await mutateThenReload(section, url, { method: 'POST' }, 'Enabling all ' + labels[section] + ' sources…');
  }));

  $('#radioForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    body.enabled = true;
    await mutateThenReload('radio', routes.radio, { method: 'POST', body: JSON.stringify(body) }, 'Adding radio station…');
    form.reset();
  });
  $('#iptvForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    await mutateThenReload('iptv', routes.iptv, { method: 'POST', body: JSON.stringify(body) }, 'Checking playlist and refreshing the catalogue…');
    form.reset();
  });
  $('#theatreForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    await mutateThenReload('theatre', routes.theatre, { method: 'POST', body: JSON.stringify(body) }, 'Checking Theatre API…');
    form.reset();
  });
  $('#importForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get('url').trim();
    if (!url) { status('theatre', 'Enter a source-list JSON URL.', true); return; }
    await mutateThenReload('theatre', routes.theatre + '/import', {
      method: 'POST', body: JSON.stringify({ url }),
    }, 'Importing source list…');
    event.currentTarget.reset();
  });

  document.querySelectorAll('#radioList,#iptvList,#theatreList').forEach((root) => root.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const section = button.dataset.section;
    const id = button.dataset.id;
    if (button.dataset.action === 'delete' && !confirm('Delete this ' + labels[section] + ' source?')) return;
    if (button.dataset.action === 'toggle') {
      await mutateThenReload(section, routes[section] + '/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }),
      });
    } else {
      await mutateThenReload(section, routes[section] + '/' + encodeURIComponent(id), { method: 'DELETE' });
    }
  }));
})();
