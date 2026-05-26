// ----- rails verticales + bookkeeping cross-thread -----

import { fmt } from './utils.js';
import { refreshHashtags } from './hashtags.js';

// Ajusta dos variables por .post:
// - --rail-bottom: distancia desde el bottom del .post hasta el fin de su
//   subtree (último descendiente). Es el alcance "estructural" del rail,
//   usado en reposo y hover.
// - --rail-active-bottom: distancia desde el bottom del .post hasta el
//   bottom de SU PROPIA .post-actions. Cuando el post está .active, el
//   rail usa esta var para acortarse y "abrazar" solo body+barra — así el
//   trazo amarillo señala inequívocamente a qué post pertenecen los botones.
// getBoundingClientRect() fuerza un sync reflow, así que las medidas son
// correctas justo tras DOM mutations (no necesitamos rAF, que no dispara
// en tabs en background).
export function extendRails(rootEl) {
  if (!rootEl) return;
  const posts = rootEl.querySelectorAll('.post');
  if (posts.length === 0) return;
  for (const post of posts) {
    const pb = post.getBoundingClientRect().bottom;
    const descendants = post.querySelectorAll('.post');
    const last = descendants.length ? descendants[descendants.length - 1] : post;
    post.style.setProperty('--rail-bottom', `${pb - last.getBoundingClientRect().bottom}px`);
    // Para el rail activo: medir hasta el bottom de la barra de acciones
    // (revelada o colapsada — su bottom coincide con el del body cuando
    // max-height:0, y queda por debajo cuando está abierta). Si no hay
    // .post-actions (caso raro), caemos al bottom del body.
    const anchor = post.querySelector(':scope > .post-actions')
      || post.querySelector(':scope > .post-body');
    if (anchor) {
      post.style.setProperty('--rail-active-bottom', `${pb - anchor.getBoundingClientRect().bottom}px`);
    }
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
