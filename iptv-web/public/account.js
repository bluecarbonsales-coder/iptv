(function () {
  'use strict';
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  };
  function mount() {
    if (document.getElementById('ownerAccountRoot')) return;
    const style = document.createElement('style');
    style.textContent = `
      #ownerAccountRoot{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#f6f4f0}
      .portal-toolbar{position:relative;z-index:60;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px clamp(14px,3vw,32px);background:rgba(11,13,18,.94);border-bottom:1px solid #282c38;backdrop-filter:blur(16px);font:13px/1.4 system-ui,-apple-system,sans-serif}
      .portal-links{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
      .portal-links a{display:inline-flex;align-items:center;padding:8px 11px;border:1px solid transparent;border-radius:10px;color:#a3a5b2;text-decoration:none;white-space:nowrap}
      .portal-links a:hover,.portal-links a.active{color:#f6f4f0;background:#ffffff09;border-color:#e8c78b45}
      .portal-account-slot{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;min-width:0}
      .portal-toolbar [hidden]{display:none!important}
      .portal-toolbar .owner-bar{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
      .portal-toolbar .owner-pill,.portal-toolbar .owner-bar button{border:1px solid #37394a;background:#151722;color:#f6f4f0;border-radius:10px;padding:8px 11px;cursor:pointer;font:inherit}
      .portal-toolbar .owner-pill{font-size:12px;color:#e8c78b;white-space:nowrap}
      .portal-toolbar .owner-bar button:hover{border-color:#e8c78b;color:#f5deb0}
      .portal-toolbar .owner-bar .owner-signin{background:#e8c78b;color:#17130b;border-color:#e8c78b;font-weight:800}
      .portal-toolbar .owner-bar .owner-signin:hover{background:#f5deb0;color:#17130b}
      @media(max-width:760px){.portal-toolbar{gap:8px;padding:9px 12px}.portal-account-slot{margin-left:0;width:100%;justify-content:flex-start}.portal-links a{padding:7px 9px}.portal-links{width:100%}}
      #ownerAccountRoot .owner-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:rgba(5,6,10,.96);backdrop-filter:blur(18px)}
      #ownerAccountRoot .owner-card{width:min(440px,100%);padding:28px;border:1px solid #37394a;border-radius:22px;background:#11131b;box-shadow:0 24px 90px #0009}
      #ownerAccountRoot h2{margin:0 0 8px;font-size:24px}#ownerAccountRoot p{color:#a9adbb}
      #ownerAccountRoot label{display:block;margin:14px 0;color:#c8cbd5;font-size:13px}
      #ownerAccountRoot input{display:block;width:100%;box-sizing:border-box;margin-top:7px;padding:12px;border:1px solid #3a3d4d;border-radius:10px;background:#090b11;color:#fff}
      #ownerAccountRoot .owner-primary{width:100%;margin-top:8px;background:#e8c78b;color:#17130b;border-color:#e8c78b;font-weight:800}
      #ownerAccountRoot .owner-error{min-height:22px;color:#ff9e9e;font-size:13px}
      #ownerAccountRoot .owner-history-list{max-height:48vh;overflow:auto;margin:16px 0;padding:0;list-style:none}
      #ownerAccountRoot .owner-history-list li{padding:10px 0;border-bottom:1px solid #303343}
      #ownerAccountRoot .owner-history-list strong{display:block}#ownerAccountRoot .owner-history-list small{color:#a9adbb}
      #ownerAccountRoot [hidden]{display:none!important}
    `;
    const root = document.createElement('div');
    root.id = 'ownerAccountRoot';
    root.innerHTML = `
      <div class="owner-bar" id="ownerBar" hidden><button type="button" class="owner-signin" id="ownerSignIn">Sign in</button><span class="owner-pill" id="ownerLabel" hidden>Signed in</span><button type="button" id="ownerHistoryButton" hidden>History</button><button type="button" id="ownerChange" hidden>Account settings</button><button type="button" id="ownerLogout" hidden>Sign out</button></div>
      <div class="owner-gate" id="ownerGate" hidden><form class="owner-card" id="ownerLoginForm"><h2>Welcome back</h2><p>Sign in once to access IPTV, Radio, Theatre and owner settings.</p><label>Username<input id="ownerUsername" autocomplete="username" required></label><label>Password<input id="ownerPassword" type="password" autocomplete="current-password" required></label><button class="owner-primary" type="submit">Sign in</button><div class="owner-error" id="ownerLoginError" role="status"></div><p style="font-size:12px">First installation uses the configured ADMIN_USERNAME and ADMIN_PASSWORD. Change them after signing in.</p></form></div>
      <div class="owner-gate" id="ownerHistoryPanel" hidden><section class="owner-card"><h2>Your media history</h2><p>Saved to this server and shared across IPTV, Radio and Theatre.</p><ul class="owner-history-list" id="ownerHistoryList"><li>Loading…</li></ul><button type="button" id="ownerHistoryClose" style="width:100%">Close</button></section></div><div class="owner-gate" id="ownerSettings" hidden><form class="owner-card" id="ownerSettingsForm"><h2>Owner account settings</h2><p>Use your current credentials to update the shared login. The new password must be at least 12 characters.</p><label>Current username<input id="ownerCurrentUsername" autocomplete="username" required></label><label>Current password<input id="ownerCurrentPassword" type="password" autocomplete="current-password" required></label><label>New username<input id="ownerNewUsername" autocomplete="username" required></label><label>New password<input id="ownerNewPassword" type="password" autocomplete="new-password" minlength="12" required></label><button class="owner-primary" type="submit">Save account changes</button><button type="button" id="ownerSettingsCancel" style="width:100%;margin-top:8px">Cancel</button><div class="owner-error" id="ownerSettingsError" role="status"></div></form></div>`;
    document.head.appendChild(style);
    document.body.appendChild(root);
    const toolbar = document.createElement('div');
    toolbar.className = 'portal-toolbar';
    toolbar.setAttribute('aria-label', 'Shared service navigation');
    const links = document.createElement('nav');
    links.className = 'portal-links';
    links.setAttribute('aria-label', 'Services');
    const services = [
      ['/', 'Home'], ['/watch.html', 'IPTV'], ['/radio.html', 'Radio'],
      ['/movies.html', 'Theatre'], ['/discover.html', 'Discover'],
      ['/library.html', 'Library'], ['/admin.html', 'Sources']
    ];
    const currentPath = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) || '/' : location.pathname;
    for (const [href, label] of services) {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = label;
      const normalizedHref = href.endsWith('/') ? href.slice(0, -1) || '/' : href;
      if (normalizedHref === currentPath || (currentPath === '/index.html' && href === '/')) link.classList.add('active');
      links.appendChild(link);
    }
    const accountSlot = document.createElement('div');
    accountSlot.className = 'portal-account-slot';
    toolbar.append(links, accountSlot);
    const pageHeader = document.querySelector('body > header');
    if (pageHeader) {
      pageHeader.querySelectorAll('nav:not(.tabs)').forEach(nav => { nav.hidden = true; });
      pageHeader.insertAdjacentElement('afterend', toolbar);
    } else document.body.prepend(toolbar);
    accountSlot.appendChild(root.querySelector('#ownerBar'));
    const $ = id => document.getElementById(id);
    let username = '';
    const gate = $('ownerGate');
    async function showHistory() {
      $('ownerHistoryPanel').hidden = false;
      const list = $('ownerHistoryList'); list.innerHTML = '<li>Loading history…</li>';
      try {
        const result = await api('/api/account/history');
        list.replaceChildren();
        if (!result.items.length) { list.innerHTML = '<li>No watch or listening history yet. Start a channel or station and it will appear here.</li>'; return; }
        for (const item of result.items) {
          const li = document.createElement('li');
          const title = document.createElement('strong'); title.textContent = item.title;
          const meta = document.createElement('small'); meta.textContent = item.type.toUpperCase() + ' · ' + (item.action === 'listen' ? 'Listened' : 'Watched') + ' · ' + new Date(item.updatedAt).toLocaleString();
          li.append(title, meta); if (item.subtitle) { const sub = document.createElement('div'); sub.textContent = item.subtitle; li.append(sub); } list.append(li);
        }
      } catch (error) { list.innerHTML = ''; const li = document.createElement('li'); li.textContent = error.message; list.append(li); }
    }
    async function refresh() {
      try {
        const result = await api('/api/account/session');
        if (result.authenticated) {
          username = result.username;
          gate.hidden = true;
          $('ownerSettings').hidden = true;
          $('ownerBar').hidden = false;
          $('ownerSignIn').hidden = true;
          $('ownerLabel').hidden = false;
          $('ownerHistoryButton').hidden = false;
          $('ownerChange').hidden = false;
          $('ownerLogout').hidden = false;
          $('ownerLabel').textContent = 'Signed in · ' + username;
        } else {
          gate.hidden = true;
          $('ownerBar').hidden = false;
          $('ownerSignIn').hidden = false;
          $('ownerLabel').hidden = true;
          $('ownerHistoryButton').hidden = true;
          $('ownerChange').hidden = true;
          $('ownerLogout').hidden = true;
        }
      } catch (error) {
        gate.hidden = true;
        $('ownerBar').hidden = false;
        $('ownerSignIn').hidden = false;
        $('ownerLabel').hidden = true;
        $('ownerHistoryButton').hidden = true;
        $('ownerChange').hidden = true;
        $('ownerLogout').hidden = true;
        $('ownerLoginError').textContent = 'Cannot connect to account service: ' + error.message;
      }
    }
    $('ownerLoginForm').addEventListener('submit', async event => {
      event.preventDefault();
      $('ownerLoginError').textContent = 'Signing in…';
      try {
        const result = await api('/api/account/login', { method: 'POST', body: JSON.stringify({ username: $('ownerUsername').value, password: $('ownerPassword').value }) });
        username = result.username;
        await refresh();
        window.dispatchEvent(new CustomEvent('owner:authenticated'));
      } catch (error) { $('ownerLoginError').textContent = error.message; }
    });
    $('ownerSignIn').addEventListener('click', () => { gate.hidden = false; $('ownerUsername').focus(); });
    $('ownerGate').addEventListener('click', event => { if (event.target === gate) gate.hidden = true; });
    $('ownerHistoryButton').addEventListener('click', showHistory);
    $('ownerHistoryClose').addEventListener('click', () => { $('ownerHistoryPanel').hidden = true; });
    $('ownerLogout').addEventListener('click', async () => {
      try { await api('/api/account/logout', { method: 'POST', body: '{}' }); } catch {}
      $('ownerPassword').value = '';
      await refresh();
    });
    $('ownerChange').addEventListener('click', () => {
      $('ownerCurrentUsername').value = username;
      $('ownerSettingsError').textContent = '';
      $('ownerSettings').hidden = false;
    });
    $('ownerSettingsCancel').addEventListener('click', () => { $('ownerSettings').hidden = true; });
    $('ownerSettingsForm').addEventListener('submit', async event => {
      event.preventDefault();
      $('ownerSettingsError').textContent = 'Saving…';
      try {
        const result = await api('/api/account/credentials', { method: 'POST', body: JSON.stringify({
          currentUsername: $('ownerCurrentUsername').value, currentPassword: $('ownerCurrentPassword').value,
          username: $('ownerNewUsername').value, password: $('ownerNewPassword').value
        }) });
        username = result.username;
        $('ownerSettingsForm').reset();
        await refresh();
        $('ownerSettingsError').textContent = result.message || 'Saved.';
      } catch (error) { $('ownerSettingsError').textContent = error.message; }
    });
    window.OwnerMediaHistory = {
      record: item => api('/api/account/history', { method: 'POST', body: JSON.stringify(item) }).catch(() => null),
      list: type => api('/api/account/history' + (type ? '?type=' + encodeURIComponent(type) : '')),
    };
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();