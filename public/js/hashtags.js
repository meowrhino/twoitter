// ----- sidebar de #tags: load + refresh on mutación -----

import { $, escapeHtml } from './utils.js';

export async function loadHashtags() {
  try {
    const res = await fetch('/api/hashtags');
    if (!res.ok) throw new Error('hashtags fetch ' + res.status);
    const tags = await res.json();
    const ul = $('#tagList');
    if (!ul) return;
    const currentTag = new URLSearchParams(location.search).get('tag');
    ul.innerHTML = tags
      .map(
        (t) =>
          `<li><a href="/?tag=${encodeURIComponent(t.tag)}"${t.tag === currentTag ? ' class="active"' : ''}>#${escapeHtml(t.tag)}<span class="count">${t.count}</span></a></li>`,
      )
      .join('');
  } catch (err) {
    // sidebar no crítico — log silencioso, sin toast para no molestar
    console.warn('loadHashtags failed', err);
  }
}

// Llamar tras crear/borrar posts para que los counts y la lista no
// queden obsoletos. No-op si el sidebar está plegado.
export function refreshHashtags() {
  if (document.body.classList.contains('sidebar-hidden')) return;
  if (!$('#tagList')) return;
  loadHashtags();
}
