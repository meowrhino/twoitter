// ----- renderizado de posts + flujo de activación -----
//
// Este módulo se ocupa de:
//   - renderPost / renderThread (estructura HTML del post)
//   - bindPostClickToNavigate + setupTapToActivate (flujo de .active)
//   - syncThreadActiveFlags (clase .thread-has-active en el root)
//
// Todo lo que toca el RAIL (geometría del rail amarillo, .extends-to-bottom
// del rail gris, el ResizeObserver) vive en rails.js; aquí sólo lo invocamos.
// Las barras de acciones (responder/ocultar/borrar/transcribir/ver twoitt)
// y sus handlers viven en post-actions.js — render.js sólo invoca su API.

import { fmt, hoursAgo, escapeHtml, linkify } from './utils.js';
import { renderPostGallery } from './gallery.js';
import { isHidden } from './hidden.js';
import {
  markExtendsToBottom,
  paintActiveRail,
  updateActiveRail,
  switchActiveRail,
  observeActiveRoot,
  scheduleRailClose,
  cancelRailClose,
} from './rails.js';
import {
  renderSinglePostActions,
  renderThreadActionsHtml,
  bindSinglePostActions,
  bindThreadActions,
  refreshThreadTranscribeBtn,
  staggerActionButtons,
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
    // refreshThreadTranscribeBtn ANTES de sync: fija qué botones se ven, para
    // que staggerActionButtons (dentro de sync) cuente sólo los visibles.
    refreshThreadTranscribeBtn(postEl);
    syncThreadActiveFlags();
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
// Además gobierna la animación del rail amarillo con UNA sola gramática:
//   - encender (no estaba activo)        → paintActiveRail: crece desde arriba
//   - cambiar de twoitt (otro .active)   → paintActiveRail: el viejo desaparece
//     de golpe y el nuevo crece desde arriba en su posición (cambiar = apagar
//     uno + encender otro, NO un "vuelo" del rail de un sitio a otro).
//   - mismo twoitt que cambia de altura  → updateActiveRail: estira/encoge suave
//     (abrir reply-inline, imagen lazy que carga tarde, transcripción).
//   - apagar (sin .active)               → scheduleRailClose: se recoge hacia
//     arriba y funde la barra (inverso de encender), no desaparece de golpe.
// Y dispara el blink de la barra cuando el .active cambia de twoitt en el mismo
// thread. Evitamos un selector :has() en CSS porque su invalidación dinámica al
// quitar una clase está bugueada en algunas versiones de Chromium.
function syncThreadActiveFlags() {
  document.querySelectorAll('.thread > .post, #replies > .post').forEach((root) => {
    const active = root.classList.contains('active')
      ? root
      : root.querySelector('.post.active');
    if (active) {
      cancelRailClose(root); // aborta un apagado en curso si lo había
      const prevId = root.dataset.lastActiveId;
      const nowId = active.dataset.id ?? '';
      // Distinguimos "mismo twoitt creciendo" de "otro twoitt". Se mide tras
      // cancelRailClose (que quita .thread-closing) y ANTES de re-añadir la clase.
      const wasActive = root.classList.contains('thread-has-active');
      // Tres caminos según qué cambió:
      //   sameTarget (mismo twoitt, sólo cambió de altura) → updateActiveRail suave
      //   otro twoitt estando ya activo                    → switchActiveRail (apaga+enciende)
      //   encendido desde cero                             → paintActiveRail (crece desde arriba)
      const sameTarget = wasActive && prevId === nowId;
      root.classList.add('thread-has-active');
      observeActiveRoot(root);
      if (sameTarget) updateActiveRail(root, active);      // mismo twoitt: suave
      else if (wasActive) switchActiveRail(root, active);  // otro twoitt: apaga+enciende
      else paintActiveRail(root, active);                  // encender: crece desde arriba
      // Recalcular la cascada de botones (sólo al encender o cambiar de target;
      // en sameTarget el conjunto visible no cambió, pero recalcular es barato).
      // Antes aquí había un "blink" (bar-flash) al cambiar de target; se quitó
      // porque switchActiveRail ya recoge+recrece el rail y los botones salen y
      // reaparecen en cascada, señalando el cambio sin parpadeo redundante.
      if (!sameTarget) staggerActionButtons(root.querySelector(':scope > .post-actions'));
      root.dataset.lastActiveId = nowId;
    } else if (root.classList.contains('thread-has-active')) {
      // Apagado animado (diferido + re-check, ver scheduleRailClose en rails.js):
      // si esto es la pasada de captura de un cambio de target, la de burbuja
      // reactivará el root y el cierre se aborta solo.
      scheduleRailClose(root);
      // No borramos lastActiveId aquí: syncThreadActiveFlags se llama dos veces
      // por click (document capture phase + .post bubble) y la primera pasada
      // ve "ningún active" momentáneamente. Si borráramos, la segunda pasada
      // perdería el ID previo y no detectaría el cambio para el blink.
      // El dato se sobreescribe en la próxima activación; queda inocuamente
      // stale si el thread se vacía permanentemente (no rompe nada).
    }
  });
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
