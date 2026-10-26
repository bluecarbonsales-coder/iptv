(function () {
  'use strict';
  const AUTH_KEY = 'iptvweb.mediaHistoryAuth';
  const $ = (selector, root) => (root || document).querySelector(selector);
  let auth = '';
  let filter = 'all';
  let dialog;
  let statusNode;
  let listNode;
  let loginForm;
  let signedInNode;
  try { auth = sessionStorage.getItem(AUTH_KEY) || ''; } catch {}
  function headers(extra) {
    const value = Object.assign({}, extra || {});
    if (auth) value.Authorization = 'Basic ' + auth;
    return value;
  }
  async function api(url, options) {
    const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}, { headers: headers(options && options.headers) }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (response.status === 401 ? 'Username or password is incorrect.' : 'Request failed (' + response.status + ')'));
    return data;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }
  function install() {
    const target = $('.topbar-actions') || $('.radio-nav') || $('.top') || $('.topbar');
    if (target) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'mediaHistoryOpen';
      button.className = target.classList.contains('radio-nav') ? 'tab' : target.classList.contains('top') ? 'iconbtn mh-open-theatre' : 'icon-btn';
      button.textContent = auth ? 'History' : 'Sign in · History';
      button.addEventListener('click', open);
      target.append(button);
    }
    dialog = document.createElement('dialog');
    dialog.id = 'mediaHistoryDialog';
    dialog.className = 'media-history-dialog';
    dialog.innerHTML = `
      <div class="mh-head"><div><span class="mh-eyebrow">YOUR MEDIA</span><h2>Watch &amp; listen history</h2><p>Saved to this IPTV Web server, across visits and restarts.</p></div><button type="button" class="mh-close" aria-label="Close">×</button></div>
      <form id="mediaHistoryLogin" class="mh-login">
        <p>Sign in with your single administrator account to sync your history.</p>
        <label>Username<input name="username" autocomplete="username" required maxlength="128"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
        <button type="submit" class="mh-primary">Sign in</button>
      </form>
      <div class="mh-signed-in" hidden><span>Signed in · history sync is on</span><button type="button" id="mediaHistoryLogout">Sign out</button></div>
      <div class="mh-toolbar"><div class="mh-filters"><button type="button" data-mh-filter="all" class="active">All</button><button type="button" data-mh-filter="iptv">IPTV</button><button type="button" data-mh-filter="radio">Radio</button><button type="button" data-mh-filter="theatre">Theatre</button></div><button type="button" id="mediaHistoryClear" class="mh-clear">Clear</button></div>
      <p id="mediaHistoryStatus" class="mh-status" role="status" aria-live="polite"></p>
      <div id="mediaHistoryList" class="mh-list"></div>`;
    document.body.append(dialog);
    statusNode = $('#mediaHistoryStatus', dialog);
    listNode = $('#mediaHistoryList', dialog);
    loginForm = $('#mediaHistoryLogin', dialog);
    signedInNode = $('.mh-signed-in', dialog);
    $('.mh-close', dialog).addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    loginForm.addEventListener('submit', signIn);
    $('#mediaHistoryLogout', dialog).addEventListener('click', signOut);
    $('#mediaHistoryClear', dialog).addEventListener('click', clearHistory);
    dialog.querySelectorAll('[data-mh-filter]').forEach((button) => button.addEventListener('click', () => {
      filter = button.dataset.mhFilter;
      dialog.querySelectorAll('[data-mh-filter]').forEach((item) => item.classList.toggle('active', item === button));
      refresh();
    }));
    syncAuthUI();
    if (auth) validateSavedAuth();
  }
  function syncAuthUI() {
    if (loginForm) loginForm.hidden = !!auth;
    if (signedInNode) signedInNode.hidden = !auth;
    const button = $('#mediaHistoryOpen');
    if (button) button.textContent = auth ? 'History' : 'Sign in · History';
  }
  async function validateSavedAuth() {
    try { await api('/api/history'); syncAuthUI(); }
    catch { signOut(false); }
  }
  async function signIn(event) {
    event.preventDefault();
    const form = new FormData(loginForm);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    const encoded = new TextEncoder().encode(username + ':' + password);
    let binary = '';
    encoded.forEach((byte) => { binary += String.fromCharCode(byte); });
    auth = btoa(binary);
    statusNode.textContent = 'Signing in…';
    statusNode.classList.remove('error');
    try {
      const data = await api('/api/history');
      try { sessionStorage.setItem(AUTH_KEY, auth); } catch {}
      loginForm.reset();
      syncAuthUI();
      statusNode.textContent = 'Signed in. Your history will now sync to the server.';
      render(data.items || []);
    } catch (error) {
      auth = '';
      statusNode.textContent = error.message;
      statusNode.classList.add('error');
      syncAuthUI();
    }
  }
  function signOut(showMessage) {
    auth = '';
    try { sessionStorage.removeItem(AUTH_KEY); } catch {}
    syncAuthUI();
    if (listNode) listNode.innerHTML = '';
    if (showMessage !== false && statusNode) statusNode.textContent = 'Signed out. History remains saved on the server.';
  }
  async function refresh() {
    if (!auth) {
      listNode.innerHTML = '';
      statusNode.textContent = 'Sign in to view and sync saved history.';
      return;
    }
    statusNode.textContent = 'Loading saved history…';
    statusNode.classList.remove('error');
    try {
      const data = await api('/api/history' + (filter === 'all' ? '' : '?type=' + encodeURIComponent(filter)));
      render(data.items || []);
      statusNode.textContent = (data.items || []).length ? (data.items.length + ' saved item' + (data.items.length === 1 ? '' : 's')) : 'No saved history yet. Start watching or listening while signed in.';
    } catch (error) {
      statusNode.textContent = error.message;
      statusNode.classList.add('error');
      if (/incorrect|sign in|401/i.test(error.message)) signOut(false);
    }
  }
  function render(items) {
    listNode.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'mh-empty';
      empty.textContent = auth ? 'No history in this category yet.' : 'Sign in to see your saved history.';
      listNode.append(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('article');
      row.className = 'mh-item';
      const meta = document.createElement('div');
      meta.className = 'mh-item-meta';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const detail = document.createElement('span');
      const when = item.playedAt ? new Date(item.playedAt).toLocaleString() : '';
      detail.textContent = [String(item.type || '').toUpperCase(), item.country || '', when].filter(Boolean).join(' · ');
      meta.append(title, detail);
      const mark = document.createElement('span');
      mark.className = 'mh-kind';
      mark.textContent = item.type === 'radio' ? '♫' : item.type === 'theatre' ? '▣' : '▶';
      row.append(mark, meta);
      listNode.append(row);
    });
  }
  async function open() {
    if (!dialog.open) dialog.showModal();
    syncAuthUI();
    await refresh();
  }
  async function clearHistory() {
    if (!auth) { statusNode.textContent = 'Sign in before clearing history.'; return; }
    if (!window.confirm('Clear saved ' + (filter === 'all' ? 'watch and listen history' : filter + ' history') + '?')) return;
    try {
      await api('/api/history' + (filter === 'all' ? '' : '?type=' + encodeURIComponent(filter)), { method: 'DELETE' });
      await refresh();
    } catch (error) {
      statusNode.textContent = error.message;
      statusNode.classList.add('error');
    }
  }
  async function record(type, item) {
    if (!auth || !item || !item.id || !item.title) return;
    try {
      await api('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        type, id: String(item.id), title: String(item.title), country: String(item.country || ''), countryCode: String(item.countryCode || ''),
      }) });
      if (dialog && dialog.open) await refresh();
    } catch (error) {
      if (/incorrect|sign in|401/i.test(error.message)) signOut(false);
    }
  }
  window.MediaHistory = { record, open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
