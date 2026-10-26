'use strict';
(() => {
  const $ = (selector) => document.querySelector(selector);
  const state = { token: '', results: [], saved: [] };

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function link(url, label) {
    const a = node('a', '', label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }
  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers['X-Source-Token'] = state.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('Request failed: HTTP ' + response.status));
    return data;
  }
  function status(message, error = false) {
    $('#status').textContent = message;
    $('#status').style.color = error ? '#ff9e9e' : '';
  }
  function renderResults(items) {
    const root = $('#results');
    root.replaceChildren();
    $('#count').textContent = items.length ? items.length + ' results' : '';
    if (!items.length) {
      root.append(node('div', 'empty', 'No results. Try another search or source.'));
      return;
    }
    for (const item of items) {
      const card = node('article', 'result');
      card.append(node('h3', '', item.title || 'Untitled result'));
      const meta = node('div', 'meta');
      [item.source, item.kind, item.license].filter(Boolean).forEach(value => meta.append(node('span', '', value)));
      card.append(meta);
      if (item.description) card.append(node('p', 'description', item.description));
      if (item.url) {
        const actions = node('div', 'actions');
        actions.append(link(item.url, /^magnet:/i.test(item.url) ? 'Open in torrent client' : 'Open source'));
        const save = node('button', '', 'Save link');
        save.type = 'button';
        save.addEventListener('click', async () => {
          if (!state.token) {
            $('#token').focus();
            status('Enter your management token to save links.', true);
            return;
          }
          save.disabled = true;
          try {
            await request('/api/media/links', { method: 'POST', body: JSON.stringify({
              title: item.title || 'Saved media link', url: item.url, kind: item.kind || 'link', source: item.source || 'Media discovery'
            }) });
            status('Saved "' + (item.title || 'media link') + '".');
          } catch (error) { status(error.message, true); }
          finally { save.disabled = false; }
        });
        actions.append(save);
        card.append(actions);
      }
      root.append(card);
    }
  }
  async function search(event) {
    if (event) event.preventDefault();
    const q = $('#query').value.trim();
    if (!q) return status('Enter a title or keyword first.', true);
    const sources = [];
    if ($('#sourceArchive').checked) sources.push('archive');
    if ($('#sourceJackett').checked) sources.push('jackett');
    if ($('#sourceSaved').checked) sources.push('saved');
    if (!sources.length) return status('Select at least one search source.', true);
    const params = new URLSearchParams({ q, sources: sources.join(',') });
    status('Searching selected sources…');
    $('#results').replaceChildren(node('div', 'empty', 'Searching…'));
    try {
      const data = await request('/api/media/search?' + params.toString());
      state.results = data.results || [];
      renderResults(state.results);
      const issues = (data.errors || []).map(item => item.source + ': ' + item.error);
      status('Search complete. ' + state.results.length + ' results.' + (issues.length ? ' ' + issues.join(' · ') : ''));
    } catch (error) {
      renderResults([]);
      status(error.message, true);
    }
  }
  function renderSaved(items) {
    const root = $('#saved');
    root.replaceChildren();
    if (!items.length) {
      root.append(node('div', 'empty', 'No saved links yet.'));
      return;
    }
    for (const item of items) {
      const card = node('article', 'result');
      card.append(node('h3', '', item.title || 'Untitled link'));
      card.append(node('div', 'meta', [item.kind || 'link', item.source || 'Saved link', item.watched ? 'Watched' : 'Not watched'].join(' · ')));
      if (item.notes) card.append(node('p', 'description', item.notes));
      const actions = node('div', 'actions');
      if (item.url) actions.append(link(item.url, /^magnet:/i.test(item.url) ? 'Open in torrent client' : 'Open link'));
      const watched = node('button', '', item.watched ? 'Mark unwatched' : 'Mark watched');
      watched.type = 'button';
      watched.addEventListener('click', async () => {
        try {
          await request('/api/media/links/' + encodeURIComponent(item.id), { method: 'PATCH', body: JSON.stringify({ watched: !item.watched }) });
          await loadSaved();
        } catch (error) { status(error.message, true); }
      });
      const remove = node('button', '', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await request('/api/media/links/' + encodeURIComponent(item.id), { method: 'DELETE' });
          await loadSaved();
          status('Saved link removed.');
        } catch (error) { status(error.message, true); }
      });
      actions.append(watched, remove);
      card.append(actions);
      root.append(card);
    }
  }
  async function loadSaved() {
    state.token = $('#token').value.trim();
    if (!state.token) {
      $('#token').focus();
      status('Enter your management token to load saved links.', true);
      return;
    }
    status('Loading saved links…');
    try {
      const data = await request('/api/media/links');
      state.saved = data.links || [];
      renderSaved(state.saved);
      status('Loaded ' + state.saved.length + ' saved links.');
    } catch (error) { status(error.message, true); }
  }
  async function saveManual(event) {
    event.preventDefault();
    state.token = $('#token').value.trim();
    if (!state.token) {
      $('#token').focus();
      status('Enter your management token to save links.', true);
      return;
    }
    const title = $('#manualTitle').value.trim();
    const url = $('#manualUrl').value.trim();
    const kind = $('#manualKind').value;
    try {
      await request('/api/media/links', { method: 'POST', body: JSON.stringify({ title, url, kind, source: 'Saved manually' }) });
      $('#manualTitle').value = '';
      $('#manualUrl').value = '';
      await loadSaved();
      status('Saved "' + title + '".');
    } catch (error) { status(error.message, true); }
  }
  $('#token').addEventListener('input', () => { state.token = $('#token').value.trim(); });
  $('#searchForm').addEventListener('submit', search);
  $('#saveForm').addEventListener('submit', saveManual);
  $('#loadSaved').addEventListener('click', loadSaved);
})();
