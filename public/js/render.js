// ----- renderizado de posts + flujo de activación -----
//
// Este módulo se ocupa de:
//   - renderPost / renderThread (estructura HTML del post)
//   - bindPostClickToNavigate + setupTapToActivate (flujo de .active)
//   - syncThreadActiveFlags (clase .thread-has-active en el root)
//   - markExtendsToBottom (clase .extends-to-bottom para los .post de
//     la "rama extrema derecha" — controla hasta dónde llega su rail)
//
// Las barras de acciones (responder/ocultar/borrar/transcribir/ver twoitt)
// y sus handlers viven en post-actions.js — render.js sólo invoca su API.

import { fmt, hoursAgo, escapeHtml, linkify } from './utils.js';
import { renderPostGallery } from './gallery.js';
import { isHidden } from './hidden.js';
import {
  renderSinglePostActions,
  renderThreadActionsHtml,
  bindSinglePostActions,
  bindThreadActions,
  refreshThreadTranscribeBtn,
} from './post-actions.js';

function renderPostFoot(p) {
  const respLink = p.reply_count
    ? `<a class="resp-count" href="/post/${p.id}">${fmt(p.reply_count)} resp</a>`
    : '';
  return `
    <div class="post-foot">
      <a href="/post/${p.id}" class="permalink" title="${escapeHtml(p.created_at)}"><span class="post-id">#${p.id}</span> · ${hoursAgo(p.created_at)}</a>
      ${respLink}
    </div>
  `;
}

// ----- bindings (encadenan eventos a un .post ya pintado) -----

// Modelo unificado desktop+touch: un click sobre el .post-body añade
// .active al .post más interno bajo el cursor. La barra de acciones del
// thread (única por root) lee ese .active como target. Click fuera (o en
// otro .post) lo quita. Para navegar al permalink, el usuario pulsa "ver
// twoitt" en la barra.
//
// Enter / Space en el .post enfocado siguen navegando directamente, porque
// el modelo de teclado no tiene "hover" ni "activo" — un sólo gesto debe
// resolver la acción primaria (abrir el post).
function bindPostClickToNavigate(postEl, p) {
  postEl.setAttribute('role', 'link');
  postEl.setAttribute('tabindex', '0');
  postEl.setAttribute('aria-label', `abrir post #${p.id}`);
  const activate = (e) => {
    if (e.target.closest('a, button, video, .composer, .gallery')) return;
    // Si el click cae sobre un descendiente .post (otro post anidado), que
    // lo gestione él — no marcar también al padre.
    if (e.target.closest('.post') !== postEl) return;
    document.querySelectorAll('.post.active').forEach((el) => {
      if (el !== postEl) el.classList.remove('active');
    });
    postEl.classList.add('active');
    syncThreadActiveFlags();
    refreshThreadTranscribeBtn(postEl);
  };
  postEl.addEventListener('click', activate);
  postEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target !== postEl) return; // ignorar si el focus está en un hijo interactivo
    e.preventDefault();
    location.href = `/post/${p.id}`;
  });
  postEl.classList.add('clickable');
}

// Global: click fuera de cualquier .post.clickable quita .active de todos.
// Click dentro de .post-actions no toca nada (deja que el botón actúe).
// Se llama una sola vez desde el entry point.
export function setupTapToActivate() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.post-actions')) return; // dejar que el botón actúe
    const post = e.target.closest?.('.post.clickable');
    document.querySelectorAll('.post.active').forEach((el) => {
      if (el !== post) el.classList.remove('active');
    });
    syncThreadActiveFlags();
  }, true);
}

// Mantiene la clase .thread-has-active en el .post root de cada thread cuando
// él o cualquier descendiente está .active. Esa clase:
//   1. Muestra la barra de .post-actions (child directo del root)
//   2. Activa el ::after del root que pinta el rail amarillo animado
// Además: pinta el rail (paintActiveRail) y dispara el blink de la barra
// cuando el .active cambia de un twoitt a otro dentro del mismo thread.
// Evitamos un selector :has() en CSS porque su invalidación dinámica al
// quitar una clase está bugueada en algunas versiones de Chromium.
function syncThreadActiveFlags() {
  document.querySelectorAll('.thread > .post, #replies > .post').forEach((root) => {
    const active = root.classList.contains('active')
      ? root
      : root.querySelector('.post.active');
    if (active) {
      const prevId = root.dataset.lastActiveId;
      const nowId = active.dataset.id ?? '';
      root.classList.add('thread-has-active');
      paintActiveRail(root, active);
      observeActiveRoot(root);
      if (prevId && prevId !== nowId) {
        // Cambio de target dentro del mismo thread: pequeño "blink" en la
        // barra para señalar que los botones ahora apuntan a otro twoitt.
        const bar = root.querySelector(':scope > .post-actions');
        if (bar) {
          bar.classList.remove('refreshing');
          // Force reflow para reiniciar la animación si estaba a medias.
          void bar.offsetWidth;
          bar.classList.add('refreshing');
        }
      }
      root.dataset.lastActiveId = nowId;
    } else {
      root.classList.remove('thread-has-active');
      unobserveActiveRoot(root);
      // No borramos lastActiveId aquí: syncThreadActiveFlags se llama dos veces
      // por click (document capture phase + .post bubble) y la primera pasada
      // ve "ningún active" momentáneamente. Si borráramos, la segunda pasada
      // perdería el ID previo y no detectaría el cambio para el blink.
      // El dato se sobreescribe en la próxima activación; queda inocuamente
      // stale si el thread se vacía permanentemente (no rompe nada).
    }
  });
}

// ----- rama extrema derecha del thread -----
//
// Un .post está en la "rama extrema derecha" si no tiene hermanos .post
// posteriores ni él ni ninguno de sus ancestros hasta el root. Los .post
// que cumplen esto llevan la clase .extends-to-bottom y su rail (gris vía
// CSS, y amarillo vía paintActiveRail) se extiende hasta el bottom del
// thread; los demás se cortan en el bottom de su propio .post para no
// atravesar visualmente a hermanos posteriores que queden a menos
// profundidad (caso típico: #97 depth 3 con #98 depth 2 debajo).
//
// Se evita un selector CSS :has() porque su invalidación dinámica al
// añadir/quitar elementos está bugueada en algunas versiones de Chromium
// (mismo motivo por el que .thread-has-active se gestiona desde JS).
// Llamar a markExtendsToBottom tras cada add/delete vía notifyThreadChanged.
function computeExtendsToBottom(post, root) {
  let cur = post;
  while (cur && cur !== root) {
    const parent = cur.parentElement;
    if (parent && parent.classList.contains('thread-replies')) {
      let sib = cur.nextElementSibling;
      while (sib && !sib.classList.contains('post')) sib = sib.nextElementSibling;
      if (sib) return false;
    }
    cur = parent ? parent.closest('.post') : null;
  }
  return true;
}
export function markExtendsToBottom(threadRoot) {
  if (!threadRoot) return;
  const all = [threadRoot, ...threadRoot.querySelectorAll('.post')];
  for (const p of all) {
    p.classList.toggle('extends-to-bottom', computeExtendsToBottom(p, threadRoot));
  }
}

// Mide el .active relativo al .post root del thread y devuelve las coords
// (px, relativas al root) que el ::after del root necesita para pintar el
// rail amarillo. height depende de si el activo lleva .extends-to-bottom
// (ver arriba): si sí, llega al bottom del root; si no, al bottom del
// propio activo.
function measureRail(rootPost, activePost) {
  const rootRect = rootPost.getBoundingClientRect();
  const activeRect = activePost.getBoundingClientRect();
  // +14 alinea con .post::before { top: 14px } (rail estructural gris).
  const top = activeRect.top - rootRect.top + 14;
  // +6 = --rail-x. activeRect.left ya incluye toda la sangría acumulada.
  const left = activeRect.left - rootRect.left + 6;
  const height = activePost.classList.contains('extends-to-bottom')
    ? rootRect.bottom - (activeRect.top + 14)
    : activeRect.bottom - (activeRect.top + 14);
  return { top, left, height };
}

// Pinta el rail con el protocolo de doble set (none → reflow → transition
// con target), que evita un bug visto en una iteración anterior: al cambiar
// de un activo a otro RÁPIDO, height transitionaba entre dos valores no
// nulos y, si el nuevo top era más alto, el rail "se desbordaba" por debajo
// (porque visual = top + height transitionado). Reseteando height a 0
// instantáneo y luego animando, el rail siempre crece desde 0. Se usa al
// ACTIVAR un twoitt o al cambiar de target dentro del thread.
function paintActiveRail(rootPost, activePost) {
  const { top, left, height } = measureRail(rootPost, activePost);
  // Fase 1: snap a la nueva posición + reset de height SIN transición.
  rootPost.style.setProperty('--active-rail-trans', 'none');
  rootPost.style.setProperty('--active-rail-top', `${top}px`);
  rootPost.style.setProperty('--active-rail-left', `${left}px`);
  rootPost.style.setProperty('--active-rail-height', '0px');
  // Force reflow para que el browser commit-ee los valores anteriores
  // antes de habilitar la transition de la fase 2.
  void rootPost.offsetWidth;
  // Fase 2: habilitar transition y disparar el fill animado a target.
  rootPost.style.removeProperty('--active-rail-trans');
  rootPost.style.setProperty('--active-rail-height', `${height}px`);
}

// Repinta el rail SIN re-snap a 0: deja la transición por defecto (height
// 320ms) activa, así crece/encoge suave cuando el root activo cambia de
// altura DESPUÉS de activarse. Lo dispara el railObserver de abajo.
function updateActiveRail(rootPost, activePost) {
  const { top, left, height } = measureRail(rootPost, activePost);
  rootPost.style.setProperty('--active-rail-top', `${top}px`);
  rootPost.style.setProperty('--active-rail-left', `${left}px`);
  rootPost.style.setProperty('--active-rail-height', `${height}px`);
}

// Un único ResizeObserver vigila el root del thread activo y repinta el
// rail ante cualquier cambio de altura del subtree. paintActiveRail solo
// corre al activar; sin esto el rail se quedaba corto cuando el post crecía
// DESPUÉS (abrir el reply-inline, imágenes loading="lazy" que cargan tarde,
// transcripción que aparece, una respuesta recién enviada). El ::after del
// rail es position:absolute → no afecta al layout del root, así que no hay
// bucle de feedback. Observamos un solo root a la vez (el activo vigente).
let observedRoot = null;
const railObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (!observedRoot) return;
        const active = observedRoot.classList.contains('active')
          ? observedRoot
          : observedRoot.querySelector('.post.active');
        if (active) updateActiveRail(observedRoot, active);
      })
    : null;

function observeActiveRoot(root) {
  if (!railObserver || observedRoot === root) return;
  if (observedRoot) railObserver.unobserve(observedRoot);
  railObserver.observe(root);
  observedRoot = root;
}
function unobserveActiveRoot(root) {
  if (!railObserver || observedRoot !== root) return;
  railObserver.unobserve(root);
  observedRoot = null;
}

// ----- renderPost / renderThread -----

export function renderPost(p, { single = false } = {}) {
  const el = document.createElement('article');
  el.className = 'post';
  el.dataset.id = p.id;
  // source of truth para updateReplyCount tras add/delete
  el.dataset.replyCount = String(p.reply_count || 0);
  // Flag para que la barra única del thread sepa si mostrar "transcribir"
  // cuando este post sea el target activo. Se actualiza tras transcribir.
  const audios = (p.media || []).filter((m) => m.kind === 'audio');
  el.dataset.hasUntranscribed = audios.some((m) => !m.transcript) ? '1' : '0';
  el.innerHTML = `
    <div class="post-body">
      <div class="post-text">${linkify(p.text || '')}</div>
      ${renderPostGallery(p.media)}
      ${renderPostFoot(p)}
    </div>
    ${single ? renderSinglePostActions(p) : ''}
  `;
  if (single) {
    bindSinglePostActions(el, p);
  } else {
    bindPostClickToNavigate(el, p);
  }
  return el;
}

// Recursivo: renderiza un post + sus replies anidados.
// Si el post raíz está oculto en localStorage, devolvemos null para que
// el caller omita el thread entero (no renderiza ni los descendientes).
// Si un descendiente está oculto, se salta SÓLO ese subtree.
//
// asRoot=true (default): este post es el root de un thread y recibe UNA
// .post-actions al final (tras .thread-replies). asRoot=false: descendiente,
// no lleva barra propia — usará la del thread root.
export function renderThread(p, { asRoot = true } = {}) {
  if (isHidden(p.id)) return null;
  const el = renderPost(p);
  if (p.replies && p.replies.length) {
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    let appended = 0;
    for (const child of p.replies) {
      const childEl = renderThread(child, { asRoot: false });
      if (childEl) { nested.appendChild(childEl); appended++; }
    }
    if (appended > 0) el.appendChild(nested);
  }
  if (asRoot) {
    // Una sola barra por thread, al final del root (tras los hijos).
    // Los handlers leen .post.active del subtree como target.
    el.insertAdjacentHTML('beforeend', renderThreadActionsHtml());
    bindThreadActions(el);
    // Marca de "rama extrema derecha" para el subtree del thread. Tras
    // add/delete se vuelve a llamar desde notifyThreadChanged (rails.js).
    markExtendsToBottom(el);
  }
  return el;
}
