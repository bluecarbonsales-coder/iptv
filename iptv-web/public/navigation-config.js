(function () {
  'use strict';
  const icons = { all: '⌂', movies: '▣', series: '▤', anime: '✧', documentary: '◉', favorites: '♡', 'live-tv': '▻', radio: '♫', mail: '✉' };
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  async function load() {
    const drawer = document.getElementById('drawer');
    if (!drawer) return;
    try {
      const response = await fetch('/api/navigation', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) throw new Error('navigation unavailable');
      const config = await response.json();
      if (!Array.isArray(config.items)) throw new Error('invalid navigation');
      const fragment = document.createDocumentFragment();
      let group = '';
      for (const item of config.items) {
        if (!item || item.enabled === false || !item.label || !item.href) continue;
        if (item.group !== group) {
          group = item.group;
          fragment.append(el('div', 'drawer-label', group));
        }
        const link = el('a', 'nav');
        link.href = item.href;
        if (item.section) link.dataset.section = item.section;
        const icon = el('span', 'ico', icons[item.section || item.id] || '↗');
        link.append(icon, document.createTextNode(item.label));
        if (item.section === 'all') link.classList.add('active');
        link.addEventListener('click', (event) => {
          if (!item.section) return;
          event.preventDefault();
          window.dispatchEvent(new CustomEvent('theatre:navigate', { detail: item.section }));
        });
        fragment.append(link);
      }
      fragment.append(el('div', 'drawer-note', 'Your private cinema. Use only sources you are authorized to access.'));
      drawer.replaceChildren(fragment);
    } catch (_) {
      // Keep the baked-in navigation as a graceful offline fallback.
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();