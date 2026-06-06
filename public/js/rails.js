// ----- rails verticales: estructura, geometría y bookkeeping del thread -----
//
// El rail vertical de cada .post tiene dos capas:
//   - estructural (gris): CSS puro. .post::before con top:14px y bottom:0 se
//     extiende solo hasta el fin del .post; los .post de la "rama extrema
//     derecha" llevan .extends-to-bottom y llegan al bottom del thread (vía
//     bottom:-9999px + el overflow:hidden del root). La marca la pone
//     markExtendsToBottom (abajo), recalculada en cada add/delete.
//   - activo (amarillo): el ::after del root del thread, posicionado con CSS
//     vars (--active-rail-{top,left,height}) que mide y setea paintActiveRail.
//     Un ResizeObserver lo repinta cuando el root activo cambia de altura.
//
// Aquí vive también el bookkeeping cross-thread (contador "N resp",
// notifyThreadChanged). render.js sólo renderiza y gestiona la activación;
// nos delega todo lo que toca el rail.

import { fmt, prefersReducedMotion, STANDARD_CURVE, ANIM_MS } from './utils.js';
import { refreshHashtags } from './hashtags.js';

// ----- contenedor lógico del thread -----

// Contenedor lógico del thread para un .post: el .thread ancestro (o null si no
// está en un thread). (Antes contemplaba el #replies de la vista single-post, ya
// eliminada — la TL es un carrete plano.)
export function getThreadRoot(postEl) {
  return postEl.closest('.thread');
}

// ----- contador "N resp" -----

// Actualiza el contador "N resp" en el footer de un .post tras add/delete.
// El número se guarda en dataset.replyCount (no se parsea del texto, que va
// con formato es-ES "1.032").
export function updateReplyCount(postEl, delta) {
  if (!postEl) return;
  const current = parseInt(postEl.dataset.replyCount || '0') || 0;
  const next = Math.max(0, current + delta);
  postEl.dataset.replyCount = String(next);

  // Acordeón: CUALQUIER nivel usa el toggle "N respuestas" que colapsa/expande
  // su propio subárbol (antes los anidados usaban un enlace .resp-count; ahora
  // todos pliegan). syncRootToggle crea/actualiza/elimina el botón según el
  // count y bindea el colapso de su .thread-replies — sirve para root y anidado.
  syncRootToggle(postEl, next);
}

// Animación del colapso de replies: misma curva y duración que el reply-inline
// (composer-anim.js), con el rail en lockstep, para que abrir/cerrar el hilo se
// sienta igual de fluido que abrir/cerrar el cuadro de responder. height:auto no
// es animable en CSS, así que medimos la altura natural y animamos con WAAPI.
// Duración y curva compartidas (ANIM_MS / STANDARD_CURVE en utils.js): las mismas
// que el composer inline, para que rail, acordeón y composer se muevan idénticos.

// ¿podemos animar? (WAAPI presente y el usuario no pidió reduced-motion).
// En reduced-motion o sin WAAPI (p.ej. tests headless) caemos a toggle directo.
function canAnimateReplies(nested) {
  return typeof nested.animate === 'function' && !prefersReducedMotion();
}

// Primitiva compartida (la usan el acordeón de replies de aquí y el composer
// inline en composer-anim.js): anima una altura 0↔natural con WAAPI dejando el
// rail en lockstep, y garantiza que `onSettle` corre EXACTAMENTE una vez. El
// fallback con setTimeout es la red para pestañas en background, donde WAAPI
// (onfinish) y el ResizeObserver se pausan y el estado final no se asentaría.
//   keyframes   — pares de la animación (height/opacity; el composer suma padding/margin)
//   onSettle    — corre al terminar (onfinish/oncancel o el fallback); idempotente
//   fallback    — añade el setTimeout(duración+120) de red (animateComposerOpen no lo usa)
//   forceFinish — el fallback además llama anim.finish() para asentar la altura
//                 (el acordeón al abrir lo necesita; el resto no)
export function animateHeight(el, keyframes, { duration, easing, onSettle, fallback = true, forceFinish = false }) {
  lockstepRail(duration + 60); // el rail crece/encoge pegado a la animación
  const anim = el.animate(keyframes, { duration, easing });
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettle();
  };
  anim.onfinish = settle;
  anim.oncancel = settle;
  if (fallback) {
    setTimeout(() => {
      if (forceFinish) { try { anim.finish(); } catch { /* ya terminó */ } }
      settle();
    }, duration + 120);
  }
  return anim;
}

function animateRepliesOpen(nested) {
  // Quitamos .replies-collapsed YA (pasa a display:block) para medir la altura
  // natural; la animación la lleva de 0 a esa altura.
  nested.classList.remove('replies-collapsed');
  if (!canAnimateReplies(nested)) { refreshActiveRail(); return; }
  const h = nested.offsetHeight;
  nested._repliesAnimating = true;
  animateHeight(nested, [
    { height: '0px', opacity: 0, overflow: 'hidden' },
    { height: `${h}px`, opacity: 1, overflow: 'hidden' },
  ], {
    duration: ANIM_MS,
    easing: STANDARD_CURVE,
    forceFinish: true, // asienta la altura a natural si onfinish no llega
    onSettle: () => { nested._repliesAnimating = false; refreshActiveRail(); },
  });
}

function animateRepliesClose(nested) {
  if (!canAnimateReplies(nested)) {
    nested.classList.add('replies-collapsed');
    refreshActiveRail();
    return;
  }
  const h = nested.offsetHeight;
  nested._repliesAnimating = true;
  // .replies-collapsed se añade al TERMINAR (si no, display:none cortaría la
  // animación), vía onSettle.
  animateHeight(nested, [
    { height: `${h}px`, opacity: 1, overflow: 'hidden' },
    { height: '0px', opacity: 0, overflow: 'hidden' },
  ], {
    duration: ANIM_MS,
    easing: STANDARD_CURVE,
    onSettle: () => {
      nested.classList.add('replies-collapsed');
      nested._repliesAnimating = false;
      refreshActiveRail();
    },
  });
}

// Toggle de colapso del subárbol de replies de un BLOQUE. Colapsado por
// defecto (.replies-collapsed → display:none en CSS). Anima la altura con la
// misma curva que el reply-inline y deja el riel amarillo en lockstep. Lo usan
// el render inicial (render.js) y syncRootToggle al crear el botón.
export function bindRepliesToggle(toggle, nested) {
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    // Ignoramos clicks mientras una animación está en curso (evita solapar dos
    // height-animations sobre el mismo subárbol).
    if (nested._repliesAnimating) return;
    const wasCollapsed = nested.classList.contains('replies-collapsed');
    if (wasCollapsed) animateRepliesOpen(nested);
    else animateRepliesClose(nested);
    // Tras el toggle, expanded = estaba colapsado. El caret (▸/▾) rota ya.
    toggle.setAttribute('aria-expanded', String(wasCollapsed));
  });
}

// Asegura que el foot de un root tenga el .resp-toggle correcto reflejando su
// nº de replies y el estado (colapsado/expandido) de su subárbol. Crea y cablea
// el botón si falta (caso: primera reply a un root, que antes dejaba un
// .resp-count incoherente), lo actualiza, o lo elimina si llega a 0. Limpia
// cualquier .resp-count residual — los roots no lo usan.
function syncRootToggle(rootPostEl, count) {
  const foot = rootPostEl.querySelector(':scope > .post-body > .post-foot');
  if (!foot) return;
  foot.querySelector('a.resp-count')?.remove();
  const nested = rootPostEl.querySelector(':scope > .thread-replies');
  let toggle = foot.querySelector('.resp-toggle');
  if (count === 0 || !nested) { toggle?.remove(); return; }
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'resp-toggle';
    foot.appendChild(toggle);
    bindRepliesToggle(toggle, nested);
  }
  toggle.setAttribute('aria-expanded', String(!nested.classList.contains('replies-collapsed')));
  toggle.textContent = `${fmt(count)} ${count === 1 ? 'respuesta' : 'respuestas'}`;
}

// ----- notificación de cambios en el thread -----

// Único punto de entrada para "algo cambió en este thread": ajusta el
// contador del padre, refresca .extends-to-bottom del subtree afectado
// (los rails geométricos los reflowea el browser solo) y refresca el
// sidebar de tags.
//   parentPost  → ancestro cuyo "N resp" hay que ajustar (null si root nuevo)
//   threadRoot  → el .thread devuelto por getThreadRoot(). Null si el cambio
//                 no afecta a un thread.
//   delta       → +1 al añadir, -1 al borrar, 0 si solo es reorder
export function notifyThreadChanged({ parentPost = null, threadRoot = null, delta = 0 } = {}) {
  if (parentPost && delta) updateReplyCount(parentPost, delta);
  if (threadRoot) {
    // El root del thread es su único hijo .post directo.
    const root = threadRoot.querySelector(':scope > .post');
    if (root) markExtendsToBottom(root);
  }
  refreshHashtags();
}

// ----- rama extrema derecha del thread (rail estructural gris) -----
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
// Lo llama notifyThreadChanged tras cada add/delete, y renderThread
// (render.js) al pintar cada thread por primera vez.
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

// ----- rail activo (amarillo) -----

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
// de un activo a otro RÁPIDO, height transicionaba entre dos valores no
// nulos y, si el nuevo top era más alto, el rail "se desbordaba" por debajo
// (porque visual = top + height transicionado). Reseteando height a 0
// instantáneo y luego animando, el rail siempre crece desde 0. Se usa al
// ACTIVAR un twoitt o al cambiar de target dentro del thread.
export function paintActiveRail(rootPost, activePost) {
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

// Repinta el rail SIN re-snap a 0: deja la transición por defecto (top/left/
// height 320ms) activa, así crece/encoge/se desliza suave cuando el root
// activo cambia de altura o el target cambia DESPUÉS de activarse. Lo dispara
// el railObserver de abajo, refreshActiveRail (reply-inline) y el cambio de
// target en syncThreadActiveFlags (render.js).
export function updateActiveRail(rootPost, activePost) {
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
// timeoutId por root de las animaciones diferidas (switch/close). Se declara
// aquí arriba porque el observer lo consulta (ver guarda en su callback).
// Nunca hay dos pendientes a la vez sobre el mismo root.
const pendingTimers = new Map();
const railObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (!observedRoot) return;
        // Si hay un switch/close EN VUELO sobre este root, no repintar: el rail
        // está recogiéndose a 0 a propósito y un updateActiveRail aquí lo haría
        // "saltar" a la altura nueva (reintroduce el vuelo que el switch evita,
        // y pelea con el cierre). El propio timer hará el repintado al terminar.
        if (pendingTimers.has(observedRoot)) return;
        const active = observedRoot.classList.contains('active')
          ? observedRoot
          : observedRoot.querySelector('.post.active');
        if (active) updateActiveRail(observedRoot, active);
      })
    : null;

export function observeActiveRoot(root) {
  if (!railObserver || observedRoot === root) return;
  if (observedRoot) railObserver.unobserve(observedRoot);
  railObserver.observe(root);
  observedRoot = root;
}
export function unobserveActiveRoot(root) {
  if (!railObserver || observedRoot !== root) return;
  railObserver.unobserve(root);
  observedRoot = null;
}

// Reajusta el rail del root activo de forma SUAVE (updateActiveRail, no
// re-snap a 0). Lo usa el reply-inline al abrir/cerrar: ese botón vive dentro
// de .post-actions, que el listener global de activación (setupTapToActivate
// en render.js) ignora a propósito — así que sin esto abrir/cerrar el reply
// dependería sólo del ResizeObserver, que es async (y no corre en pestañas
// ocultas). Llamarlo síncrono tras insertar/quitar el composer estira o
// encoge el rail en el mismo gesto. No-op si no hay root activo.
export function refreshActiveRail() {
  if (!observedRoot) return;
  const active = observedRoot.classList.contains('active')
    ? observedRoot
    : observedRoot.querySelector('.post.active');
  if (active) updateActiveRail(observedRoot, active);
}

// ----- apagado + cambio de twoitt: animaciones diferidas del rail -----
//
// Dos gestos del rail necesitan un timer (recoger, esperar, y luego limpiar o
// repintar). Nunca hay dos pendientes a la vez sobre el mismo root, así que un
// único Map basta; clearPending() cancela el que hubiera.
//
//   APAGAR (clic fuera): no quitamos .thread-has-active de golpe (haría
//   desaparecer rail+barra al instante). Lo "recogemos hacia arriba" (height→0
//   con top fijo, inverso de encender) + fundimos la barra (.thread-closing), y
//   sólo tras la animación quitamos las clases y limpiamos las vars.
//
//   CAMBIAR de twoitt: cambiar = apagar uno + encender otro, NO un "vuelo" del
//   rail. switchActiveRail recoge el viejo hacia arriba (height→0, top intacto)
//   y, al terminar, crece desde arriba en la nueva posición (paintActiveRail).
//
// syncThreadActiveFlags corre DOS veces por click (capture + bubble). Al
// cambiar de target, la pasada de captura ve "ningún activo" un instante y
// pediría cerrar; por eso scheduleRailClose difiere con queueMicrotask y
// re-checa: si para cuando corre el root ya recuperó un .active (la pasada de
// burbuja), aborta. Y la rama activa llama cancelRailClose, que limpia tanto un
// cierre como un cambio pendiente antes de programar el nuevo gesto.
const RAIL_CLOSE_MS = 360;  // > 320ms de la transición de height (cleanup)
const RAIL_SWITCH_MS = 340; // espera a que el viejo se recoja antes de crecer
// pendingTimers se declara arriba (lo consulta el ResizeObserver).

function clearPending(root) {
  const t = pendingTimers.get(root);
  if (t) { clearTimeout(t); pendingTimers.delete(root); }
}

// Cambiar de twoitt activo dentro del mismo thread: recoge el rail viejo y
// luego lo enciende en el nuevo sitio (secuencial, no vuela).
export function switchActiveRail(rootPost, activePost) {
  clearPending(rootPost); // cancela un cierre/cambio en curso
  // Fase A: recoger el viejo hacia arriba. height→0 con la transición por
  // defecto; NO tocamos top/left, así se encoge en su sitio en vez de viajar.
  rootPost.style.removeProperty('--active-rail-trans');
  rootPost.style.setProperty('--active-rail-height', '0px');
  // Fase B: tras recogerse, crecer desde arriba en la NUEVA posición.
  const tid = setTimeout(() => {
    pendingTimers.delete(rootPost);
    paintActiveRail(rootPost, activePost);
  }, RAIL_SWITCH_MS);
  pendingTimers.set(rootPost, tid);
}

function startRailClose(root) {
  if (root.classList.contains('thread-closing')) return; // ya cerrándose
  clearPending(root); // cancela un cambio pendiente si lo había
  root.classList.add('thread-closing'); // funde la barra + saca los botones en
  // cascada inversa (izquierda→derecha), todo vía CSS (.thread-closing button).
  root.style.setProperty('--active-rail-height', '0px'); // recoge hacia arriba
  unobserveActiveRoot(root);
  const tid = setTimeout(() => {
    pendingTimers.delete(root);
    root.classList.remove('thread-has-active', 'thread-closing');
    root.style.removeProperty('--active-rail-top');
    root.style.removeProperty('--active-rail-left');
    root.style.removeProperty('--active-rail-height');
    root.style.removeProperty('--active-rail-trans');
  }, RAIL_CLOSE_MS);
  pendingTimers.set(root, tid);
}

export function scheduleRailClose(root) {
  queueMicrotask(() => {
    // Re-check tras asentar el click completo (capture + bubble).
    if (root.classList.contains('active') || root.querySelector('.post.active')) return;
    if (!root.classList.contains('thread-has-active')) return;
    startRailClose(root);
  });
}

export function cancelRailClose(root) {
  clearPending(root); // cancela cierre O cambio pendiente
  root.classList.remove('thread-closing');
}

// ----- lockstep con una animación de altura externa (composer abriéndose) -----
//
// Cuando el reply-inline crece/encoge animado, el .post root cambia de altura y
// el ResizeObserver de arriba repinta el rail. Pero con la transición CSS del
// rail activa (320ms), el rail "persigue" un target que se mueve → llega con
// lag. lockstepRail desactiva esa transición durante `duration` ms: el observer
// setea height = altura real del post en cada frame SIN suavizado, así el rail
// queda pegado exacto a la animación del composer. Al terminar restaura la
// transición (salvo que un switch/close ya la esté gestionando).
let lockstepTimer = null;
export function lockstepRail(duration = 360) {
  if (!observedRoot) return;
  const root = observedRoot;
  root.style.setProperty('--active-rail-trans', 'none');
  if (lockstepTimer) clearTimeout(lockstepTimer);
  lockstepTimer = setTimeout(() => {
    lockstepTimer = null;
    if (!pendingTimers.has(root)) root.style.removeProperty('--active-rail-trans');
  }, duration);
}

// ----- liberar el rail al borrar/ocultar un twoitt -----
//
// Llamar DESPUÉS de quitar nodos del DOM (doDelete/doHide → removeFromDom).
// El ResizeObserver y observedRoot son estado de módulo con referencia FUERTE
// al .post root activo; si ese root (o un ancestro) se borra, quedarían
// apuntando a un nodo detached hasta la siguiente activación, y si el borrado
// fue el propio .active, el rail amarillo se quedaría "colgado" sobre el hueco.
// releaseRail detecta ambos casos y limpia:
//   - root detached (se borró él o su .thread)      → suelta observer + timer
//   - root vivo pero ya sin ningún .active dentro    → apaga el rail al instante
//     (clases + CSS vars) y suelta el observer
// No-op si no hay root observado o si sigue teniendo un activo (se borró otro).
export function releaseRail() {
  if (!observedRoot) return;
  const stillActive = observedRoot.isConnected &&
    (observedRoot.classList.contains('active') || observedRoot.querySelector('.post.active'));
  if (stillActive) return;
  clearPending(observedRoot);
  if (lockstepTimer) { clearTimeout(lockstepTimer); lockstepTimer = null; }
  railObserver?.unobserve(observedRoot);
  if (observedRoot.isConnected) {
    observedRoot.classList.remove('thread-has-active', 'thread-closing');
    observedRoot.style.removeProperty('--active-rail-top');
    observedRoot.style.removeProperty('--active-rail-left');
    observedRoot.style.removeProperty('--active-rail-height');
    observedRoot.style.removeProperty('--active-rail-trans');
  }
  observedRoot = null;
}
