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
import { renderPoll, bindPollActions } from './render-poll.js';
import { isHidden, markPostHidden } from './hidden.js';
import {
  markExtendsToBottom,
  paintActiveRail,
  updateActiveRail,
  switchActiveRail,
  observeActiveRoot,
  scheduleRailClose,
  cancelRailClose,
  bindRepliesToggle,
} from './rails.js';
import {
  renderThreadActionsHtml,
  bindThreadActions,
  refreshThreadTranscribeBtn,
  refreshThreadHideBtn,
  staggerActionButtons,
} from './post-actions.js';

function renderPostFoot(p, { collapsible = false } = {}) {
  // Permalink ahora es un hash a la posición del post en la TL (no /post/:id,
  // que ya no existe). Server redirige 301 los enlaces antiguos.
  //
  // El contador de respuestas tiene dos formas según el contexto:
  //   - root del BLOQUE (collapsible) → BOTÓN que colapsa/expande el subárbol
  //     de replies anidadas (colapsado por defecto). El subárbol está oculto y
  //     este toggle lo revela in-situ.
  //   - reply anidada → enlace hash a su propia posición en el carrete.
  let respEl = '';
  if (p.reply_count) {
    const label = `${fmt(p.reply_count)} ${p.reply_count === 1 ? 'respuesta' : 'respuestas'}`;
    respEl = collapsible
      ? `<button type="button" class="resp-toggle" aria-expanded="false">${label}</button>`
      : `<a class="resp-count" href="#${p.id}">${fmt(p.reply_count)} resp</a>`;
  }
  return `
    <div class="post-foot">
      <a href="#${p.id}" class="permalink" title="${escapeHtml(p.created_at)}"><span class="post-id">#${p.id}</span> · ${hoursAgo(p.created_at)}</a>
      ${renderLocation(p)}
      ${respEl}
    </div>
  `;
}

// "📍 ubicación" en el pie. Si hay lat+lng → link a un mapa (Google Maps `?q=`,
// que en móvil abre la app de mapas instalada; en escritorio, la web). La
// etiqueta es el nombre si lo escribiste, o las coordenadas si no. Sin coords y
// sin nombre → nada. El nombre se escapa (texto libre); las coords son números.
function renderLocation(p) {
  const hasCoords = p.lat != null && p.lng != null;
  if (!p.location && !hasCoords) return '';
  const label = escapeHtml(
    p.location || `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`,
  );
  if (hasCoords) {
    const url = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
    return `<a class="post-loc" href="${url}" target="_blank" rel="noopener noreferrer">📍 ${label}</a>`;
  }
  return `<span class="post-loc">📍 ${label}</span>`;
}

// ----- encuesta -----
// El markup (renderPoll) y el wiring de voto (bindPollActions) viven ahora en
// render-poll.js; renderPost los invoca vía import. Se extrajeron por ser un
// subsistema (UI de encuestas) ajeno al render de hilos/activación de aquí.

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
    // El stub "este post está oculto" SÍ activa el post (excepción al salto de
    // botones): así, al revelar un oculto, la barra aparece con "desocultar".
    if (e.target.closest('a, button:not(.hidden-stub), video, .composer, .gallery')) return;
    // Si el click cae sobre un descendiente .post (otro post anidado), que
    // lo gestione él — no marcar también al padre.
    if (e.target.closest('.post') !== postEl) return;
    document.querySelectorAll('.post.active').forEach((el) => {
      if (el !== postEl) el.classList.remove('active');
    });
    postEl.classList.add('active');
    // refreshThread*Btn ANTES de sync: fijan qué botones se ven, para que
    // staggerActionButtons (dentro de sync) cuente sólo los visibles.
    refreshThreadTranscribeBtn(postEl);
    refreshThreadHideBtn(postEl);
    syncThreadActiveFlags();
  };
  postEl.addEventListener('click', activate);
  postEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target !== postEl) return; // ignorar si el focus está en un hijo interactivo
    e.preventDefault();
    // hash en vez de navegar — el listener de hashchange hace scroll+activación.
    location.hash = '#' + p.id;
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
  // El manejo de `hashchange` vive en pages.js (loadUntilHashPost): necesita
  // la paginación para cargar el post si aún no está en el DOM. Aquí solo
  // exponemos focusPostFromHash, que pages.js invoca tras asegurar la carga.
}

// Foco programático del post identificado por location.hash: scroll + activa.
// Lo invoca pages.js (loadUntilHashPost) tras asegurarse de que el post esté
// cargado, tanto en la carga inicial con /#id como en cada hashchange.
//
// Tolerante: si el id no existe en el DOM (link roto / post borrado), no-op
// silencioso tras agotar la paginación.
//
// Detalle de la duplicación reply (ítem suelto + anidado): querySelector
// devuelve el primero en orden DOM, que con cron desc suele ser la
// versión "ítem propio" — el comportamiento esperado.
export function focusPostFromHash(behavior = 'smooth') {
  const id = location.hash.replace(/^#/, '');
  if (!id) return;
  const el = document.querySelector(`article.post[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  // Si navegas a un post que ocultaste, lo revelamos: vienes a verlo, no a
  // toparte con el stub. Sigue marcado como oculto (la barra ofrece desocultar).
  if (el.classList.contains('post-hidden')) el.classList.add('revealed');
  el.scrollIntoView({ behavior, block: 'center' });
  // Activación atómica: quitar .active de cualquier otro y poner a este.
  document.querySelectorAll('.post.active').forEach((other) => {
    if (other !== el) other.classList.remove('active');
  });
  el.classList.add('active');
  // refreshThread*Btn ANTES de sync (igual que bindPostClickToNavigate): fijan
  // qué botones se ven para que staggerActionButtons cuente solo los visibles.
  // Sin el de ocultar, un post alcanzado por /#id mostraba "ocultar" estando ya
  // oculto (la barra es única por thread y conserva el estado de la activación
  // anterior).
  refreshThreadTranscribeBtn(el);
  refreshThreadHideBtn(el);
  syncThreadActiveFlags();
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
  document.querySelectorAll('.thread > .post').forEach((root) => {
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

// renderPost(p, {topLevel}). topLevel=true significa "este post es root de
// su BLOQUE en la TL". Solo en ese caso pintamos el header "↓ en respuesta
// a (…)" cuando p es una reply (parent_id != null): dentro del BLOQUE del
// padre se renderiza también anidado, pero allí el contexto ya se entiende
// y no repetimos el header.
export function renderPost(p, { topLevel = true } = {}) {
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
      ${topLevel ? renderReplyContext(p.parent_excerpt) : ''}
      <div class="post-text">${linkify(p.text || '')}</div>
      ${renderPoll(p.poll)}
      ${renderPostGallery(p.media)}
      ${renderPostFoot(p, { collapsible: !!(p.replies && p.replies.length) })}
    </div>
  `;

  if (p.poll) bindPollActions(el, p);
  bindPostClickToNavigate(el, p);
  // Oculto en este navegador → colapsar a placeholder "este post está oculto"
  // (revelable). No se quita del DOM; "desocultar" en la barra lo recupera.
  if (isHidden(p.id)) markPostHidden(el);
  return el;
}

// Header "↓ en respuesta a: «snippet del padre»" (estilo x.com/with_replies).
// excerpt viene del backend (parent_excerpt). Si el padre está borrado, no
// linkamos: clicar #<id-borrado> no haría nada útil.
function renderReplyContext(excerpt) {
  if (!excerpt) return '';
  if (excerpt.deleted) {
    return `<span class="reply-context reply-context-deleted">↓ en respuesta a un twoitt borrado</span>`;
  }
  const snippet = escapeHtml(excerpt.text_snippet || '').trim() || `#${excerpt.id}`;
  return `<a class="reply-context" href="#${excerpt.id}">↓ en respuesta a: <span class="parent-snippet">${snippet}</span></a>`;
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
  // Los ocultos YA no se omiten (return null): renderPost los pinta como
  // placeholder revelable. Así siempre hay forma de recuperarlos.
  // topLevel coincide con asRoot: solo el root del BLOQUE muestra el
  // header "en respuesta a (…)" si es una reply. Los descendientes ya
  // están dentro del BLOQUE de su padre — repetir el header sería ruido.
  const el = renderPost(p, { topLevel: asRoot });
  if (p.replies && p.replies.length) {
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    let appended = 0;
    for (const child of p.replies) {
      const childEl = renderThread(child, { asRoot: false });
      if (childEl) { nested.appendChild(childEl); appended++; }
    }
    if (appended > 0) {
      el.appendChild(nested);
      // Acordeón de niveles: CADA post con respuestas arranca con su subárbol
      // COLAPSADO y su propio toggle "N respuestas". Al expandir un nivel se ven
      // sus hijos directos, cada uno plegado a su vez — el hilo se abre capa a
      // capa en lugar de desplegar todo el subárbol de golpe. (Antes solo el
      // root del BLOQUE colapsaba; al abrirlo se mostraban todos los niveles.)
      nested.classList.add('replies-collapsed');
      const toggle = el.querySelector(':scope > .post-body > .post-foot > .resp-toggle');
      if (toggle) bindRepliesToggle(toggle, nested);
    }
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
