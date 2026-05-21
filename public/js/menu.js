// ----- menú lateral / hamburguesa + filtro banner -----

import { $, escapeHtml } from './utils.js';
import { SIDEBAR_KEY } from './state.js';
import { loadHashtags } from './hashtags.js';

export function setupMenu() {
  const btn = $('#menuBtn');
  const panel = $('#menuPanel');
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !panel.hidden;
    panel.hidden = open;
    btn.setAttribute('aria-expanded', String(!open));
    btn.classList.toggle('open', !open);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('open');
    }
  });

  const search = $('#searchBox');
  if (search) {
    const initialQ = new URLSearchParams(location.search).get('q');
    if (initialQ) search.value = initialQ;
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = search.value.trim();
        location.href = q ? `/?q=${encodeURIComponent(q)}` : '/';
      }
    });
  }

  const tog = $('#toggleSidebar');
  if (tog) {
    tog.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('sidebar-hidden');
      localStorage.setItem(SIDEBAR_KEY, hidden ? 'closed' : 'open');
      tog.textContent = hidden ? 'mostrar #tags' : 'ocultar #tags';
      if (!hidden) loadHashtags();
    });
  }
}

export function setupFilterBanner() {
  const tag = new URLSearchParams(location.search).get('tag');
  const q = new URLSearchParams(location.search).get('q');
  const b = $('#filterBanner');
  if (!b) return;
  if (tag || q) {
    b.hidden = false;
    b.innerHTML = `<span>filtro: ${tag ? `#${escapeHtml(tag)}` : `"${escapeHtml(q)}"`}</span><a href="/">limpiar</a>`;
  } else {
    b.hidden = true;
  }
}
