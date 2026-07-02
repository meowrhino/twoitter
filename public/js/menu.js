// ----- menú lateral / hamburguesa + filtro banner -----

import { $, $$, escapeHtml } from './utils.js';
import { SIDEBAR_KEY } from './state.js';
import { loadHashtags } from './hashtags.js';

// Etiquetas legibles de cada ?type= para el link activo del menú y el
// filter banner. Mismos valores que acepta GET /api/posts (src/index.ts).
const TYPE_LABELS = {
  image: 'imágenes',
  video: 'vídeos',
  audio: 'audios',
  poll: 'encuestas',
  lyrics: 'letras',
};

// Resalta el link del tipo activo en el menú (markup estático en index.html,
// a diferencia de #tagList que se genera desde /api/hashtags).
function setupTypeFilter() {
  const wrap = $('#typeFilter');
  if (!wrap) return;
  const current = new URLSearchParams(location.search).get('type');
  for (const a of $$('a', wrap)) {
    const t = new URL(a.getAttribute('href'), location.origin).searchParams.get('type');
    a.classList.toggle('active', !!current && t === current);
  }
}

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

  setupTypeFilter();
}

export function setupFilterBanner() {
  const tag = new URLSearchParams(location.search).get('tag');
  const q = new URLSearchParams(location.search).get('q');
  const type = new URLSearchParams(location.search).get('type');
  const b = $('#filterBanner');
  if (!b) return;
  if (tag || q || type) {
    b.hidden = false;
    const label = tag
      ? `#${escapeHtml(tag)}`
      : q
        ? `"${escapeHtml(q)}"`
        : `tipo: ${escapeHtml(TYPE_LABELS[type] || type)}`;
    b.innerHTML = `<span>filtro: ${label}</span><a href="/">limpiar</a>`;
  } else {
    b.hidden = true;
  }
}
