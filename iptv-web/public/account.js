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
      .portal-toolbar{position:fixed;inset:0 0 auto;z-index:1000;height:58px;display:flex;align-items:center;gap:12px;flex-wrap:nowrap;padding:7px clamp(10px,2vw,26px);background:rgba(11,13,18,.97);border-bottom:1px solid #282c38;backdrop-filter:blur(16px);font:13px/1.4 system-ui,-apple-system,sans-serif;transition:transform .2s ease;will-change:transform}
      .portal-toolbar.is-hidden{transform:translateY(-105%)}
      .portal-links{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;flex-wrap:nowrap;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none}
      .portal-links::-webkit-scrollbar{display:none}
      .portal-links a{display:inline-flex;align-items:center;padding:8px 11px;border:1px solid transparent;border-radius:10px;color:#a3a5b2;text-decoration:none;white-space:nowrap}
      .portal-links a:hover,.portal-links a.active{color:#f6f4f0;background:#ffffff09;border-color:#e8c78b45}
      .portal-account-slot{margin-left:auto;display:flex;align-items:center;justify-content:flex-end;min-width:0;flex:0 0 auto}
      .portal-toolbar [hidden],header nav[hidden]{display:none!important}
      .portal-toolbar .owner-bar{display:flex;gap:6px;align-items:center;flex-wrap:nowrap}
      .portal-toolbar .owner-pill,.portal-toolbar .owner-bar button{border:1px solid #37394a;background:#151722;color:#f6f4f0;border-radius:10px;padding:8px 11px;cursor:pointer;font:inherit}
      .portal-toolbar .owner-pill{font-size:12px;color:#e8c78b;white-space:nowrap}
      .portal-toolbar .owner-bar button:hover{border-color:#e8c78b;color:#f5deb0}
      .portal-toolbar .owner-bar .owner-signin{background:#e8c78b;color:#17130b;border-color:#e8c78b;font-weight:800}
      .portal-toolbar .owner-bar .owner-signin:hover{background:#f5deb0;color:#17130b}
      @media(max-width:760px){.portal-toolbar{height:58px;gap:7px;padding:7px 8px}.portal-account-slot{margin-left:auto;width:auto;justify-content:flex-end}.portal-links{width:auto;flex:1 1 auto}.portal-links a{padding:7px 8px;font-size:12px}.portal-toolbar .owner-pill{max-width:100px;overflow:hidden;text-overflow:ellipsis}.portal-toolbar .owner-bar{gap:4px}.portal-toolbar .owner-pill,.portal-toolbar .owner-bar button{padding:7px 8px;font-size:11px}.portal-toolbar.is-hidden{transform:none}}
      .portal-account-slot{position:relative;display:flex;align-items:center;justify-content:flex-end;flex:0 0 auto;margin-left:auto;z-index:1000}
      .portal-account-slot.is-floating{position:fixed;top:10px;right:12px;z-index:1000}
      .portal-account-slot [hidden]{display:none!important}
      .portal-account-slot .owner-bar{display:flex;align-items:center;position:relative}
      .portal-account-slot .owner-signin{width:38px;height:38px;display:grid;place-items:center;border:1px solid #e8c78b75;background:#151722;color:#e8c78b;border-radius:50%;font-size:18px;cursor:pointer}
      .portal-account-slot .owner-signin:hover{background:#e8c78b;color:#17130b}
      .portal-account-slot .owner-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:1100;min-width:190px;padding:8px;display:grid;gap:5px;background:#10121a;border:1px solid #37394a;border-radius:12px;box-shadow:0 16px 42px #000b}
      .portal-account-slot .owner-menu button,.portal-account-slot .owner-menu .owner-pill{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;color:#f6f4f0;border-radius:8px;padding:9px 11px;cursor:pointer;font:inherit}
      .portal-account-slot .owner-menu button:hover{border-color:#e8c78b55;background:#ffffff08}
      .portal-account-slot .owner-menu .owner-pill{font-size:12px;color:#e8c78b;cursor:default}
      #ownerAccountRoot .owner-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:rgba(5,6,10,.96);backdrop-filter:blur(18px)}
      #ownerAccountRoot .owner-card{width:min(440px,100%);padding:28px;border:1px solid #37394a;border-radius:22px;background:#11131b;box-shadow:0 24px 90px #0009}
      #ownerAccountRoot h2{margin:0 0 8px;font-size:24px}#ownerAccountRoot p{color:#a9adbb}
      #ownerAccountRoot label{display:block;margin:14px 0;color:#c8cbd5;font-size:13px}
      #ownerAccountRoot input{display:block;width:100%;box-sizing:border-box;margin-top:7px;padding:12px;border:1px solid #3a3d4d;border-radius:10px;background:#090b11;color:#fff}
      #ownerAccountRoot .owner-primary{width:100%;margin-top:8px;background:#e8c78b;color:#17130b;border-color:#e8c78b;font-weight:800}
      #ownerAccountRoot .owner-error{min-height:22px;color:#ff9e9e;font-size:13px}
      #ownerAccountRoot .owner-history-list{max-height:48vh;overflow:auto;margin:16px 0;padding:0;list-style:none}
      #ownerAccountRoot .owner-history-list li{padding:10px 0;border-bottom:1px solid #303343}
      #ownerAccountRoot .history-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      #ownerAccountRoot .history-actions button{font-size:12px;padding:5px 9px;border:1px solid #37394a;border-radius:8px;background:#151722;color:#f6f4f0;cursor:pointer}
      #ownerAccountRoot .history-actions button:hover{border-color:#e8c78b}
      #ownerAccountRoot .owner-history-list strong{display:block}#ownerAccountRoot .owner-history-list small{color:#a9adbb}
      #ownerAccountRoot [hidden]{display:none!important}
    `;
    const root = document.createElement('div');
    root.id = 'ownerAccountRoot';
    root.innerHTML = `
      <div class="owner-bar" id="ownerBar" hidden><button type="button" class="owner-signin" id="ownerSignIn" aria-label="Private owner access" title="Private owner access" aria-expanded="false">⚙</button><div class="owner-menu" id="ownerMenu" hidden><span class="owner-pill" id="ownerLabel" hidden>Signed in</span><button type="button" id="ownerHistoryButton" hidden>History</button><button type="button" id="ownerAdmin" hidden>Manage all services</button><button type="button" id="ownerChange" hidden>Account credentials</button><button type="button" id="ownerLogout" hidden>Sign out</button></div></div>
      <div class="owner-gate" id="ownerGate" hidden><form class="owner-card" id="ownerLoginForm"><h2>Welcome back</h2><p>Sign in once to access IPTV, Radio, Theatre and owner settings.</p><label>Username<input id="ownerUsername" autocomplete="username" required></label><label>Password<input id="ownerPassword" type="password" autocomplete="current-password" required></label><button class="owner-primary" type="submit">Sign in</button><div class="owner-error" id="ownerLoginError" role="status"></div><p style="font-size:12px">First installation uses the configured ADMIN_USERNAME and ADMIN_PASSWORD. Change them after signing in.</p></form></div>
      <div class="owner-gate" id="ownerHistoryPanel" hidden><section class="owner-card"><h2>Your media history</h2><p>Saved to this server and shared across IPTV, Radio and Theatre.</p><ul class="owner-history-list" id="ownerHistoryList"><li>Loading…</li></ul><button type="button" id="ownerHistoryClose" style="width:100%">Close</button></section></div><div class="owner-gate" id="ownerSettings" hidden><form class="owner-card" id="ownerSettingsForm"><h2>Owner account settings</h2><p>Use your current credentials to update the shared login. The new password must be at least 12 characters.</p><label>Current username<input id="ownerCurrentUsername" autocomplete="username" required></label><label>Current password<input id="ownerCurrentPassword" type="password" autocomplete="current-password" required></label><label>New username<input id="ownerNewUsername" autocomplete="username" required></label><label>New password<input id="ownerNewPassword" type="password" autocomplete="new-password" minlength="12" required></label><button class="owner-primary" type="submit">Save account changes</button><button type="button" id="ownerSettingsCancel" style="width:100%;margin-top:8px">Cancel</button><div class="owner-error" id="ownerSettingsError" role="status"></div></form></div>`;
    document.head.appendChild(style);
    document.body.appendChild(root);
    const accountSlot = document.createElement('div');
    accountSlot.className = 'portal-account-slot';
    const pageHeader = document.querySelector('body > header');
    if (pageHeader) {
      pageHeader.appendChild(accountSlot);
    } else {
      accountSlot.classList.add('is-floating');
      document.body.appendChild(accountSlot);
    }
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
          const title = document.createElement('strong'); title.textContent = (item.pinned ? '📌 ' : '') + item.title;
          const meta = document.createElement('small'); meta.textContent = item.type.toUpperCase() + ' · ' + (item.action === 'listen' ? 'Listened' : 'Watched') + ' · ' + new Date(item.updatedAt).toLocaleString();
          li.append(title, meta); if (item.subtitle) { const sub = document.createElement('div'); sub.textContent = item.subtitle; li.append(sub); }
          const actions = document.createElement('div'); actions.className = 'history-actions';
          const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Continue';
          resume.addEventListener('click', () => { const target = item.url && /^https?:\/\//i.test(item.url) ? item.url : (item.type === 'radio' ? '/radio.html' : item.type === 'iptv' ? '/watch.html' : '/movies.html'); location.href = target; });
          const pin = document.createElement('button'); pin.type = 'button'; pin.textContent = item.pinned ? 'Unpin' : 'Pin';
          pin.addEventListener('click', async () => { try { await api('/api/account/history/' + encodeURIComponent(item.id), { method: 'PATCH', body: JSON.stringify({ pinned: !item.pinned }) }); await showHistory(); } catch (error) { alert(error.message); } });
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
          remove.addEventListener('click', async () => { if (!confirm('Delete this history item?')) return; try { await api('/api/account/history/' + encodeURIComponent(item.id), { method: 'DELETE' }); await showHistory(); } catch (error) { alert(error.message); } });
          actions.append(resume, pin, remove); li.append(actions); list.append(li);
        }
      } catch (error) { list.innerHTML = ''; const li = document.createElement('li'); li.textContent = error.message; list.append(li); }
    }
    function syncOwnerOnly(authenticated) {
      document.querySelectorAll('[data-owner-only]').forEach(node => { node.hidden = !authenticated; });
    }
    async function refresh() {
      try {
        const result = await api('/api/account/session');
        const authenticated = Boolean(result.authenticated);
        username = authenticated ? result.username : '';
        gate.hidden = true;
        $('ownerSettings').hidden = true;
        $('ownerBar').hidden = false;
        $('ownerSignIn').hidden = false;
        $('ownerSignIn').title = authenticated ? 'Owner menu' : 'Private owner access';
        $('ownerSignIn').setAttribute('aria-expanded', 'false');
        $('ownerMenu').hidden = true;
        $('ownerLabel').hidden = !authenticated;
        $('ownerHistoryButton').hidden = !authenticated;
        $('ownerAdmin').hidden = !authenticated;
        $('ownerChange').hidden = !authenticated;
        $('ownerLogout').hidden = !authenticated;
        $('ownerLabel').textContent = authenticated ? 'Signed in · ' + username : '';
        syncOwnerOnly(authenticated);
      } catch (error) {
        username = '';
        gate.hidden = true;
        $('ownerBar').hidden = false;
        $('ownerSignIn').hidden = false;
        $('ownerSignIn').title = 'Private owner access';
        $('ownerSignIn').setAttribute('aria-expanded', 'false');
        $('ownerMenu').hidden = true;
        $('ownerLabel').hidden = true;
        $('ownerHistoryButton').hidden = true;
        $('ownerAdmin').hidden = true;
        $('ownerChange').hidden = true;
        $('ownerLogout').hidden = true;
        syncOwnerOnly(false);
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
    $('ownerSignIn').addEventListener('click', () => { if (username) { $('ownerMenu').hidden = !$('ownerMenu').hidden; $('ownerSignIn').setAttribute('aria-expanded', String(!$('ownerMenu').hidden)); } else { gate.hidden = false; $('ownerUsername').focus(); } });
    $('ownerGate').addEventListener('click', event => { if (event.target === gate) gate.hidden = true; });
    $('ownerHistoryButton').addEventListener('click', () => { $('ownerMenu').hidden = true; showHistory(); });
    $('ownerAdmin').addEventListener('click', () => { location.href = '/admin.html'; });
    $('ownerHistoryClose').addEventListener('click', () => { $('ownerHistoryPanel').hidden = true; });
    $('ownerLogout').addEventListener('click', async () => {
      $('ownerMenu').hidden = true;
      try { await api('/api/account/logout', { method: 'POST', body: '{}' }); } catch {}
      $('ownerPassword').value = '';
      await refresh();
    });
    $('ownerChange').addEventListener('click', () => {
      $('ownerMenu').hidden = true;
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