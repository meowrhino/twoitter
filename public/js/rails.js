// ----- rails verticales + bookkeeping cross-thread -----

import { fmt } from './utils.js';
import { refreshHashtags } from './hashtags.js';

// Ajusta --rail-bottom de cada .post para que su rail termine al fin de
// SU PROPIO subtree (último .post descendiente o sí mismo). El rail
// representa el alcance del subtree, no del thread completo.
// getBoundingClientRect() fuerza un sync reflow, así que las medidas son
// correctas justo tras DOM mutations (no necesitamos rAF, que no dispara
// en tabs en background).
export function extendRails(rootEl) {
  if (!rootEl) return;
  const posts = rootEl.querySelectorAll('.post');
  if (posts.length === 0) return;
  for (const post of posts) {
    const descendants = post.querySelectorAll('.post');
    const last = descendants.length ? descendants[descendants.length - 1] : post;
    const target = last.getBoundingClientRect().bottom;
    const pb = post.getBoundingClientRect().bottom;
    post.style.setProperty('--rail-bottom', `${pb - target}px`);
  }
  ensureRailObserver(rootEl);
}

// ResizeObserver compartido: cuando un .thread cambia de altura (ej. al
// cargarse una imagen async), recalcula sus rails sin que haga falta un
// evento explícito.
const _railObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
      for (const e of entries) extendRails(e.target);
    })
  : null;

function ensureRailObserver(threadEl) {
  if (!_railObserver || threadEl._railObserved) return;
  threadEl._railObserved = true;
  _railObserver.observe(threadEl);
}

// Contenedor lógico del thread para un .post:
// - timeline: el .thread ancestro
// - single (replies anidados): el #replies ancestro
// - single (post principal): null (no tiene rail)
export function getThreadRoot(postEl) {
  return postEl.closest('.thread') || postEl.closest('#replies');
}

export function extendAllRails() {
  for (const t of document.querySelectorAll('.thread, #replies')) {
    extendRails(t);
  }
}

// debounced resize + safety net en window.load (por si imágenes/vídeos
// terminaron de cargar después de la medida inicial y el ResizeObserver
// no llegó a disparar). app.js es type=module (defer), así que en
// navegadores rápidos `load` ya disparó cuando llegamos aquí — en ese
// caso lo ejecutamos inmediatamente; si no, registramos el listener.
export function setupResizeRailRecalc() {
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(extendAllRails, 100);
  });
  if (document.readyState === 'complete') extendAllRails();
  else window.addEventListener('load', extendAllRails, { once: true });
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
// contador del padre, reextiende los rails y refresca el sidebar de tags.
//   parentPost  → ancestro cuyo "N resp" hay que ajustar (null si root nuevo)
//   threadRoot  → .thread o #replies a re-medir (null para skip)
//   delta       → +1 al añadir, -1 al borrar, 0 si solo es reorder
export function notifyThreadChanged({ parentPost = null, threadRoot = null, delta = 0 } = {}) {
  if (parentPost && delta) updateReplyCount(parentPost, delta);
  if (threadRoot) {
    if (threadRoot.isConnected) {
      extendRails(threadRoot);
    } else if (_railObserver && threadRoot._railObserved) {
      // Thread detached: liberar la referencia del ResizeObserver para que
      // el nodo no quede retenido en sesiones largas con muchos delete.
      _railObserver.unobserve(threadRoot);
      threadRoot._railObserved = false;
    }
  }
  refreshHashtags();
}
