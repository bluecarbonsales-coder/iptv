'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const token = () => $('token').value.trim();
  const headers = () => ({'Content-Type':'application/json','X-Source-Token':token()});
  async function api(url, options = {}) {
    const response = await fetch(url, options), data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ')');
    return data;
  }
  function resultCard(item, saved = false) {
    const openUrl = item.streamUrl || item.url || item.pageUrl;
    const validHref = /^https?:\/\//i.test(openUrl || '') || /^magnet:\?/i.test(openUrl || '');
    return '<article class="result"><h3>' + escapeHtml(item.title || item.name || 'Untitled') + '</h3><div class="meta"><span>' + escapeHtml(item.source || item.sourceName || 'External source') + '</span><span>·</span><span>' + escapeHtml(item.kind || item.license || 'link') + '</span>' + (item.year ? '<span>· ' + escapeHtml(item.year) + '</span>' : '') + '</div><p class="description">' + escapeHtml(item.description || item.overview || item.notes || item.license || 'External link; availability and rights depend on the source.') + '</p><div class="actions">' + (validHref ? '<a href="' + escapeHtml(openUrl) + '" target="_blank" rel="noopener noreferrer">' + (/^magnet:/i.test(openUrl) ? 'Open magnet' : item.playable && item.streamUrl ? 'Play video' : 'Open source') + ' ↗</a>' : '') + (item.pageUrl && item.pageUrl !== openUrl ? '<a href="' + escapeHtml(item.pageUrl) + '" target="_blank" rel="noopener noreferrer">Details ↗</a>' : '') + (saved ? '<button data-watched="' + escapeHtml(item.id) + '">' + (item.watched ? 'Mark unwatched' : 'Mark watched') + '</button><button data-delete="' + escapeHtml(item.id) + '">Remove</button>' : '<button data-save="' + escapeHtml(encodeURIComponent(JSON.stringify({title:item.title || item.name || 'Untitled',url:item.url || item.pageUrl || '',kind:item.kind || 'link',source:item.source || item.sourceName || 'Search result',notes:item.license || ''}))) + '">Save link</button>') + '</div></article>';
  }
  $('searchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = $('query').value.trim();
    const sources = [$('sourceArchive').checked ? 'archive' : '', $('sourceJackett').checked ? 'jackett' : ''].filter(Boolean).join(',');
    if (!sources) { $('status').textContent = 'Select at least one search source.'; return; }
    $('status').textContent = 'Searching configured sources…'; $('results').innerHTML = ''; $('count').textContent = '';
    try {
      const data = await api('/api/media/search?q=' + encodeURIComponent(q) + '&sources=' + encodeURIComponent(sources));
      $('results').innerHTML = data.results.length ? data.results.map(item => resultCard(item)).join('') : '<div class="empty">No results. Configure Jackett for torrent search or try another query.</div>';
      $('count').textContent = data.results.length + ' results';
      $('status').textContent = data.errors.length ? data.errors.map(e => e.source + ': ' + e.error).join(' · ') : 'Search complete.';
    } catch (e) { $('status').textContent = e.message; }
  });
  $('results').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save]'); if (!button) return;
    if (!token()) { $('status').textContent = 'Enter a management token before saving links.'; $('token').focus(); return; }
    try {
      const item = JSON.parse(decodeURIComponent(button.dataset.save));
      if (!item.url) throw new Error('This result has no saveable URL.');
      await api('/api/media/links', {method:'POST',headers:headers(),body:JSON.stringify(item)});
      button.textContent = 'Saved'; button.disabled = true;
    } catch (e) { $('status').textContent = e.message; }
  });
  async function loadSaved() {
    if (!token()) { $('saved').innerHTML = '<div class="empty">Enter a management token first.</div>'; return; }
    $('saved').innerHTML = '<div class="empty">Loading saved links…</div>';
    try {
      const data = await api('/api/media/links', {headers:headers()});
      $('saved').innerHTML = data.links.length ? data.links.map(item => resultCard(item, true)).join('') : '<div class="empty">No saved links yet.</div>';
    } catch (e) { $('saved').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>'; }
  }
  $('loadSaved').addEventListener('click', loadSaved);
  $('saved').addEventListener('click', async (event) => {
    const del = event.target.closest('[data-delete]'), watched = event.target.closest('[data-watched]');
    try {
      if (del) await api('/api/media/links/' + encodeURIComponent(del.dataset.delete), {method:'DELETE',headers:headers()});
      else if (watched) {
        const id = watched.dataset.watched;
        await api('/api/media/links/' + encodeURIComponent(id), {method:'PATCH',headers:headers(),body:JSON.stringify({watched:watched.textContent === 'Mark unwatched'})});
      } else return;
      await loadSaved();
    } catch (e) { $('status').textContent = e.message; }
  });
})();