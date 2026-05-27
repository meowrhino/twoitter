// ----- rails verticales + bookkeeping cross-thread -----
//
// El rail vertical de cada .post lo pinta CSS puro: .post::before con
// top:14px y bottom:0 se extiende automáticamente hasta el fin del .post,
// que por construcción del DOM (ver renderThread) es:
//   - root:   bottom de .post-actions (último hijo, la barra del thread)
//   - nested: bottom de su .thread-replies (si tiene hijos) o de su body
// No medimos alturas en JS — el browser ya lo hace al layout-ar. Antes este
// archivo tenía extendRails + ResizeObserver + setupResizeRailRecalc para
// ajustar --rail-bottom; quedó obsoleto al pasar a CSS puro.

import { fmt } from './utils.js';
import { refreshHashtags } from './hashtags.js';

// Contenedor lógico del thread para un .post:
// - timeline: el .thread ancestro
// - single (replies anidados): el #replies ancestro
// - single (post principal): null (no tiene rail)
export function getThreadRoot(postEl) {
  return postEl.closest('.thread') || postEl.closest('#replies');
}

// Actualiza el contador "N resp" en el footer de un .post tras add/delete.
// El número se guarda en dataset.replyCount (no se parsea del texto, que va
// con formato es-ES "1.032").
export function updateReplyCount(postEl, delta) {
  if (!postEl) return;
  const current = parseInt(postEl.dataset.replyCount || '0') || 0;
  const next = Math.max(0, current + delta);
  postEl.dataset.replyCount = String(next);

  const foot = postEl.querySelector(':scope > .post-body > .post-foot');
  if (!foot) return;
  const permalink = foot.querySelector('.permalink');
  let countLink = foot.querySelector('a.resp-count');

  if (next === 0) { countLink?.remove(); return; }
  if (countLink) {
    countLink.textContent = `${fmt(next)} resp`;
  } else if (permalink) {
    countLink = document.createElement('a');
    countLink.className = 'resp-count';
    countLink.href = permalink.getAttribute('href');
    countLink.textContent = `${fmt(next)} resp`;
    permalink.after(countLink);
  }
}

// Único punto de entrada para "algo cambió en este thread": ajusta el
// contador del padre y refresca el sidebar de tags. Los rails son CSS puro
// y se actualizan solos al reflow — no hay nada que reextender aquí.
//   parentPost  → ancestro cuyo "N resp" hay que ajustar (null si root nuevo)
//   threadRoot  → reservado por compat con callers; ya no se usa
//   delta       → +1 al añadir, -1 al borrar, 0 si solo es reorder
export function notifyThreadChanged({ parentPost = null, threadRoot = null, delta = 0 } = {}) {
  if (parentPost && delta) updateReplyCount(parentPost, delta);
  refreshHashtags();
}
