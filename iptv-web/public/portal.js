(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const state = { services: [], category: 'All', query: '', canManage: false, editingId: null, availability: {}, availabilityScanning: false, fastestResource: null, availabilityScanCompletedAt: null };
  let availabilityTimer = null;
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
  function formatLatency(value) {
    if (!Number.isFinite(Number(value)) || value < 0) return '—';
    const ms = Number(value);
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
  }
  function availabilityLabel(item) {
    if (!item) return { text: 'Checking…', status: 'checking' };
    if (item.status === 'local') return { text: 'Local · available', status: 'local' };
    if (item.status === 'online') return { text: 'Available · ' + formatLatency(item.latencyMs), status: 'online' };
    if (item.status === 'slow') return { text: 'Slow · ' + formatLatency(item.latencyMs), status: 'slow' };
    if (item.status === 'restricted') return { text: (item.httpStatus === 429 ? 'Rate limited' : 'Restricted') + (item.httpStatus ? ' · HTTP ' + item.httpStatus : ''), status: 'restricted' };
    if (item.status === 'not_found') return { text: 'Not found · HTTP ' + (item.httpStatus || 404), status: 'not-found' };
    if (item.status === 'unavailable') return { text: 'Unavailable' + (item.httpStatus ? ' · HTTP ' + item.httpStatus : ''), status: 'offline' };
    if (item.status === 'offline') return { text: 'Offline' + (item.reason === 'timeout' ? ' · timed out' : ''), status: 'offline' };
    return { text: 'Checking…', status: 'checking' };
  }
  function renderRecommendation() {
    const title = $('#fastestTitle');
    const details = $('#fastestDetails');
    const summary = $('#availabilitySummary');
    title.replaceChildren();
    const statuses = Object.values(state.availability);
    const count = (status) => statuses.filter((item) => item.status === status).length;
    const working = count('online') + count('slow');
    const limited = count('restricted') + count('not_found');
    const offline = count('offline') + count('unavailable');
    summary.textContent = (state.availabilityScanning ? 'Checking · ' : 'Checked · ') +
      working + ' responsive' + (limited ? ' · ' + limited + ' restricted/missing' : '') +
      (offline ? ' · ' + offline + ' offline' : '');
    if (state.fastestResource) {
      const service = state.services.find((item) => String(item.id) === String(state.fastestResource.id));
      const lead = document.createElement('span');
      lead.textContent = 'Fastest responding media resource: ';
      const link = document.createElement('a');
      link.href = service ? safeHref(service.url) : '#';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = state.fastestResource.name + ' · ' + formatLatency(state.fastestResource.latencyMs);
      title.append(lead, link);
      details.textContent = 'Measured from this app server to the site. Lower website response time does not guarantee faster video playback or better speed from your device.';
    } else if (state.availabilityScanning) {
      title.textContent = 'Checking SeedHub and Streambert…';
      details.textContent = 'The recommendation appears when at least one media resource responds successfully.';
    } else {
      title.textContent = 'No responsive media resource detected';
      details.textContent = 'One or both resources may be offline, blocked from the server, or returning an error. “Restricted” is different from offline.';
    }
    $('#availabilityRefresh').disabled = state.availabilityScanning;
    $('#availabilityRefresh').textContent = state.availabilityScanning ? 'Checking…' : '↻ Check now';
  }
  async function loadAvailability(force) {
    try {
      const url = '/api/portal/availability' + (force ? '?refresh=1' : '');
      const data = await request(url, { cache: 'no-store' });
      state.availability = Object.fromEntries((data.statuses || []).map((item) => [String(item.id), item]));
      state.availabilityScanning = Boolean(data.scanning);
      state.fastestResource = data.fastest || null;
      state.availabilityScanCompletedAt = data.scanCompletedAt || null;
      renderServices();
    } catch (error) {
      $('#availabilitySummary').textContent = 'Availability check unavailable';
      $('#fastestTitle').textContent = 'Source status could not be loaded';
      $('#fastestDetails').textContent = error.message;
    } finally {
      clearTimeout(availabilityTimer);
      availabilityTimer = setTimeout(() => loadAvailability(false), state.availabilityScanning ? 4000 : 60000);
    }
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

    const result = availabilityLabel(state.availability[String(service.id)]);
    const availability = document.createElement('div');
    availability.className = 'service-availability availability-' + result.status;
    if (state.availability[String(service.id)] && state.availability[String(service.id)].checkedAt) {
      availability.title = 'Checked ' + new Date(state.availability[String(service.id)].checkedAt).toLocaleString() + ' from the app server';
    } else {
      availability.title = 'Source availability is checked from the app server';
    }
    const indicator = document.createElement('span');
    indicator.className = 'availability-dot';
    indicator.setAttribute('aria-hidden', 'true');
    const availabilityText = document.createElement('span');
    availabilityText.textContent = result.text;
    availability.append(indicator, availabilityText);
    card.append(availability);

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
    renderRecommendation();
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
    $('#btnAdd').hidden = true;
    $('#btnLock').hidden = true;
    $('#btnManage').hidden = true;
    $('#manageNote').hidden = false;
    $('#unlockPanel').hidden = true;
    $('#manageActions').hidden = true;
  }
  async function loadServices() {
    try {
      const data = await request('/api/portal/services');
      state.services = Array.isArray(data.services) ? data.services : [];
      buildCategories();
      renderServices();
      $('#pageStatus').textContent = 'Your links are stored on this server.';
      loadAvailability(false);
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
    location.assign('/admin.html');
  }

  function lock() {
    state.canManage = false;
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
    $('#availabilityRefresh').addEventListener('click', () => loadAvailability(true));
    $('#search').addEventListener('input', () => {
      state.query = $('#search').value;
      renderServices();
    });
    $('#btnManage').addEventListener('click', () => {
      $('#unlockPanel').hidden = false;
      $('#unlockPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      location.assign('/admin.html');
      $('#manageStatus').className = 'status';
    });
    $('#unlockForm').addEventListener('submit', (event) => { event.preventDefault(); location.assign('/admin.html'); });
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