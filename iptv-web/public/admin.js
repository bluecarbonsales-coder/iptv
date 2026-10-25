(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const state = { auth: '', active: 'radio' };
  const routes = {
    radio: '/admin/api/radio/sources',
    iptv: '/admin/api/iptv/sources',
    theatre: '/admin/api/theatre/sources',
  };
  const labels = { radio: 'Radio', iptv: 'IPTV', theatre: 'Theatre' };
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
      renderList(section, sources);
      status(section, sources.length + ' source(s).');
    } catch (error) {
      status(section, error.message, true);
    }
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
