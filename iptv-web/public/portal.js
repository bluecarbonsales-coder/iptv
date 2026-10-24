(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const state = { services: [], category: 'All', query: '', canManage: false, token: '', editingId: null };
  const grid = $('#serviceGrid');
  const categoryList = $('#categoryList');
  const status = $('#manageStatus');

  function safeText(value) { return String(value == null ? '' : value); }
  function safeHref(value) {
    const url = safeText(value).trim();
    if (url.startsWith('/') && !url.startsWith('//') && !url.split(/[?#]/, 1)[0].split('/').includes('..')) return url;
    try {
      const parsed = new URL(url);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) return parsed.href;
    } catch {}
    return '#';
  }
  function hostFor(url) {
    try { return new URL(url, location.origin).host; } catch { return 'Invalid link'; }
  }
  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2800);
  }
  async function request(url, options) {
    const response = await fetch(url, options || {});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ('Request failed (' + response.status + ')'));
    return body;
  }
  function headers(json) {
    const result = {};
    if (json) result['Content-Type'] = 'application/json';
    if (state.token) result['X-Source-Token'] = state.token;
    return result;
  }
  function filteredServices() {
    const q = state.query.trim().toLocaleLowerCase();
    return state.services.filter((service) => {
      const catOk = state.category === 'All' || service.category === state.category;
      const text = [service.name, service.description, service.url, service.category].join(' ').toLocaleLowerCase();
      const qOk = !q || text.includes(q);
      return catOk && qOk;
    });
  }
  function buildCategories() {
    const cats = ['All', ...new Set(state.services.map((service) => service.category).filter(Boolean).sort((a, b) => a.localeCompare(b)))];
    if (!cats.includes(state.category)) state.category = 'All';
    categoryList.replaceChildren();
    cats.forEach((category) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'category-chip' + (state.category === category ? ' active' : '');
      button.textContent = category;
      button.setAttribute('aria-pressed', String(state.category === category));
      button.addEventListener('click', () => {
        state.category = category;
        buildCategories();
        renderServices();
      });
      categoryList.append(button);
    });
  }
  function makeIcon(service) {
    const icon = document.createElement('span');
    icon.className = 'service-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = safeText(service.icon || '↗');
    return icon;
  }
  function editButton(label, symbol, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-action';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = symbol;
    button.addEventListener('click', action);
    return button;
  }
  function makeCard(service) {
    const card = document.createElement('article');
    card.className = 'service-card' + (service.featured ? ' featured' : '');
    const top = document.createElement('div');
    top.className = 'card-top';
    top.append(makeIcon(service));
    if (state.canManage) {
      const actions = document.createElement('div');
      actions.className = 'service-actions';
      actions.append(editButton('Edit ' + service.name, '✎', () => openEditor(service)));
      actions.append(editButton('Delete ' + service.name, '×', () => deleteService(service)));
      top.append(actions);
    }
    card.append(top);

    const link = document.createElement('a');
    link.className = 'service-main';
    link.href = safeHref(service.url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', 'Open ' + service.name + ' in a new tab');
    const name = document.createElement('div');
    name.className = 'service-name';
    name.textContent = safeText(service.name);
    const desc = document.createElement('div');
    desc.className = 'service-desc';
    desc.textContent = safeText(service.description) || 'Open this service.';
    link.append(name, desc);
    card.append(link);

    const bottom = document.createElement('div');
    bottom.className = 'service-bottom';
    const category = document.createElement('span');
    category.className = 'service-category';
    category.textContent = safeText(service.category || 'Other');
    const host = document.createElement('span');
    host.className = 'service-host';
    host.title = safeText(service.url);
    host.textContent = hostFor(service.url);
    const arrow = document.createElement('span');
    arrow.className = 'open-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    bottom.append(category, host, arrow);
    card.append(bottom);
    return card;
  }
  function renderServices() {
    const services = filteredServices();
    grid.replaceChildren();
    if (!services.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const title = document.createElement('strong');
      title.textContent = state.query || state.category !== 'All' ? 'No matching services' : 'No services yet';
      const message = document.createElement('span');
      message.textContent = state.canManage ? 'Add a service to create your own shortcuts.' : 'Try another search or category.';
      empty.append(title, message);
      if (state.canManage && !state.query) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn primary';
        add.textContent = '＋ Add a service';
        add.style.marginTop = '16px';
        add.addEventListener('click', () => openEditor());
        empty.append(add);
      }
      grid.append(empty);
    } else {
      services.forEach((service) => grid.append(makeCard(service)));
    }
    $('#serviceCount').textContent = String(state.services.length);
    $('#visibleCount').textContent = String(services.length);
    $('#heroStat').textContent = String(state.services.length).padStart(2, '0');
    $('#btnAdd').hidden = !state.canManage;
    $('#btnLock').hidden = !state.canManage;
    $('#btnManage').hidden = state.canManage;
    $('#manageNote').hidden = state.canManage;
    $('#unlockPanel').hidden = state.canManage;
    $('#manageActions').hidden = !state.canManage;
  }
  async function loadServices() {
    try {
      const data = await request('/api/portal/services');
      state.services = Array.isArray(data.services) ? data.services : [];
      buildCategories();
      renderServices();
      $('#pageStatus').textContent = 'Your links are stored on this server.';
    } catch (error) {
      $('#pageStatus').textContent = error.message;
      grid.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty';
      const title = document.createElement('strong');
      title.textContent = 'Could not load the service list';
      const message = document.createElement('span');
      message.textContent = error.message;
      empty.append(title, message);
      grid.append(empty);
    }
  }
  async function unlock() {
    state.token = $('#manageToken').value.trim();
    if (!state.token) { showToast('Enter your management token first.'); return; }
    $('#unlockButton').disabled = true;
    status.textContent = 'Checking access…';
    status.className = 'status';
    try {
      const data = await request('/api/portal/services?manage=1', { headers: headers(false) });
      state.services = Array.isArray(data.services) ? data.services : [];
      state.canManage = true;
      $('#manageToken').value = '';
      status.textContent = 'Link management enabled for this page session.';
      status.className = 'status ok';
      buildCategories();
      renderServices();
      showToast('Service management unlocked.');
    } catch (error) {
      state.token = '';
      status.textContent = error.message;
      status.className = 'status error';
    } finally {
      $('#unlockButton').disabled = false;
    }
  }
  function lock() {
    state.canManage = false;
    state.token = '';
    status.textContent = 'Management locked.';
    status.className = 'status';
    renderServices();
    showToast('Management locked.');
  }
  function openEditor(service) {
    if (!state.canManage) return;
    state.editingId = service ? service.id : null;
    $('#serviceDialogTitle').textContent = service ? 'Edit service' : 'Add a service';
    $('#fieldName').value = service ? service.name : '';
    $('#fieldUrl').value = service ? service.url : '';
    $('#fieldDescription').value = service ? service.description || '' : '';
    $('#fieldCategory').value = service ? service.category || 'Other' : 'Other';
    $('#fieldIcon').value = service ? service.icon || '↗' : '🔗';
    $('#fieldFeatured').checked = service ? service.featured === true : false;
    $('#fieldOrder').value = service && Number.isFinite(Number(service.order)) ? service.order : '';
    $('#formStatus').textContent = '';
    $('#formStatus').className = 'status';
    $('#serviceDialog').showModal();
    $('#fieldName').focus();
  }
  function closeEditor() {
    if ($('#serviceDialog').open) $('#serviceDialog').close();
  }
  async function saveService() {
    const body = {
      name: $('#fieldName').value.trim(),
      url: $('#fieldUrl').value.trim(),
      description: $('#fieldDescription').value.trim(),
      category: $('#fieldCategory').value.trim() || 'Other',
      icon: $('#fieldIcon').value.trim() || '↗',
      featured: $('#fieldFeatured').checked,
      order: $('#fieldOrder').value === '' ? 1000 : Number($('#fieldOrder').value),
    };
    if (!body.name || !body.url) {
      $('#formStatus').textContent = 'Name and URL are required.';
      $('#formStatus').className = 'status error';
      return;
    }
    const button = $('#saveService');
    button.disabled = true;
    $('#formStatus').textContent = 'Saving…';
    $('#formStatus').className = 'status';
    try {
      const editing = Boolean(state.editingId);
      const url = editing ? '/api/portal/services/' + encodeURIComponent(state.editingId) : '/api/portal/services';
      const data = await request(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: headers(true),
        body: JSON.stringify(body),
      });
      if (editing) state.services = state.services.map((item) => item.id === state.editingId ? data.service : item);
      else state.services.push(data.service);
      closeEditor();
      buildCategories();
      renderServices();
      showToast(editing ? 'Service updated.' : 'Service added.');
    } catch (error) {
      $('#formStatus').textContent = error.message;
      $('#formStatus').className = 'status error';
    } finally {
      button.disabled = false;
    }
  }
  async function deleteService(service) {
    if (!state.canManage || !window.confirm('Remove "' + service.name + '" from the homepage? This will not affect the service itself.')) return;
    try {
      await request('/api/portal/services/' + encodeURIComponent(service.id), { method: 'DELETE', headers: headers(false) });
      state.services = state.services.filter((item) => item.id !== service.id);
      buildCategories();
      renderServices();
      showToast('Link removed. The external service was not changed.');
    } catch (error) {
      showToast(error.message);
    }
  }
  function bindEvents() {
    $('#search').addEventListener('input', () => {
      state.query = $('#search').value;
      renderServices();
    });
    $('#btnManage').addEventListener('click', () => {
      $('#unlockPanel').hidden = false;
      $('#manageToken').focus();
      $('#manageStatus').textContent = 'Use SOURCE_TOKEN, REFRESH_TOKEN or AGENT_API_TOKEN from the server environment.';
      $('#manageStatus').className = 'status';
    });
    $('#unlockForm').addEventListener('submit', (event) => { event.preventDefault(); unlock(); });
    $('#hideUnlock').addEventListener('click', () => { $('#unlockPanel').hidden = true; });
    $('#btnLock').addEventListener('click', lock);
    $('#btnAdd').addEventListener('click', () => openEditor());
    $('#serviceForm').addEventListener('submit', (event) => { event.preventDefault(); saveService(); });
    $('#cancelEditor').addEventListener('click', closeEditor);
    $('#closeEditor').addEventListener('click', closeEditor);
    $('#serviceDialog').addEventListener('click', (event) => {
      if (event.target === $('#serviceDialog')) closeEditor();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        event.preventDefault();
        $('#search').focus();
      }
    });
  }

  bindEvents();
  loadServices();
})();