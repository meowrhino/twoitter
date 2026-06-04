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

import { fmt, hoursAgo, escapeHtml, linkify, toast } from './utils.js';
import { api } from './api.js';
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
  renderThreadActionsHtml,
  bindThreadActions,
  refreshThreadTranscribeBtn,
  staggerActionButtons,
} from './post-actions.js';

function renderPostFoot(p) {
  // Permalink ahora es un hash a la posición del post en la TL (no /post/:id,
  // que ya no existe). Server redirige 301 los enlaces antiguos.
  const respLink = p.reply_count
    ? `<a class="resp-count" href="#${p.id}">${fmt(p.reply_count)} resp</a>`
    : '';
  return `
    <div class="post-foot">
      <a href="#${p.id}" class="permalink" title="${escapeHtml(p.created_at)}"><span class="post-id">#${p.id}</span> · ${hoursAgo(p.created_at)}</a>
      ${respLink}
    </div>
  `;
}

// ----- encuesta -----
//
// Markup de un bloque de encuesta. Resultados siempre visibles: la barra
// se rellena al % aunque no hayas votado. Si ya votaste (poll.my_vote_id),
// los botones quedan como divs estáticos con marca "tu voto". Si no, son
// botones clicables.
//
// Esquema del payload:
//   poll: {
//     options: [{ id, position, label, votes }],
//     total_votes: number,
//     my_vote_id: number | null,
//   }
function renderPoll(poll) {
  if (!poll) return '';
  const total = poll.total_votes || 0;
  const voted = poll.my_vote_id != null;
  const items = poll.options
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
      const mine = poll.my_vote_id === o.id;
      const tag = voted ? 'div' : 'button';
      const typeAttr = voted ? '' : 'type="button"';
      const cls = ['poll-option'];
      if (voted) cls.push('poll-option-static');
      if (mine) cls.push('poll-option-mine');
      const mineDot = mine ? '<span class="poll-mine-dot" aria-label="tu voto">●</span>' : '';
      return `
        <${tag} ${typeAttr} class="${cls.join(' ')}" data-option-id="${o.id}">
          <span class="poll-bar" style="width: ${pct}%"></span>
          <span class="poll-row">
            <span class="poll-pct">${pct}%</span>
            <span class="poll-label">${escapeHtml(o.label)}</span>
            ${mineDot}
          </span>
        </${tag}>
      `;
    })
    .join('');
  const totalLabel = total === 1 ? '1 voto' : `${fmt(total)} votos`;
  return `
    <div class="poll" data-poll data-voted="${voted ? '1' : '0'}">
      ${items}
      <div class="poll-foot">${totalLabel}</div>
    </div>
  `;
}

// Wire de los botones clicables del bloque encuesta. Sólo se llama si
// el visitante aún no ha votado (los <div> estáticos no necesitan
// handler). Optimismo controlado: tras éxito repintamos el bloque con
// la respuesta del servidor (que ya trae my_vote_id) en lugar de
// estimar localmente.
function bindPollActions(postEl, p) {
  const block = postEl.querySelector(':scope > .post-body .poll');
  if (!block) return;
  if (block.dataset.voted === '1') return;
  const buttons = block.querySelectorAll('.poll-option');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      // stopPropagation: en el feed, hacer clic en una opción no debe
      // activar el post (eso lo gestiona activation.js a nivel document).
      e.stopPropagation();
      if (btn.disabled) return;
      const optionId = parseInt(btn.dataset.optionId, 10);
      buttons.forEach((b) => (b.disabled = true));
      const { ok, status, data } = await api(`/api/posts/${p.id}/poll/vote`, {
        method: 'POST',
        body: { option_id: optionId },
      });
      // 409 = ya votaste: aún así el server devuelve poll actualizado.
      if (!ok && status !== 409) {
        toast(data?.error || 'error al votar', 'error');
        buttons.forEach((b) => (b.disabled = false));
        return;
      }
      const newPoll = data?.poll;
      if (newPoll) {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderPoll(newPoll);
        const fresh = wrap.firstElementChild;
        block.replaceWith(fresh);
        // tras votar es estático → no necesita rewire.
      }
    });
  });
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
    // hash en vez de navegar — el listener de hashchange hace scroll+activación.
    location.hash = '#' + p.id;
  });
  postEl.classList.add('clickable');
}

// Global: click fuera de cualquier .post.clickable quita .active de todos.
// Click dentro de .post-actions no toca nada (deja que el botón actúe).
// Se llama una sola vez desde el entry point.
//
// También registra el listener de `hashchange`: cuando el hash cambia (por
// click en un permalink, en "↓ en respuesta a", en "ver twoitt" o por
// edición manual de la URL), centramos el post y lo activamos.
export function setupTapToActivate() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.post-actions')) return; // dejar que el botón actúe
    const post = e.target.closest?.('.post.clickable');
    document.querySelectorAll('.post.active').forEach((el) => {
      if (el !== post) el.classList.remove('active');
    });
    syncThreadActiveFlags();
  }, true);
  window.addEventListener('hashchange', () => focusPostFromHash('smooth'));
}

// Foco programático del post identificado por location.hash. Casos de uso:
//   - hashchange (click interno en un link #id)
//   - cierre del primer render del feed: si entras con /#42 directamente,
//     loadTimeline lo llama con 'instant' tras pintar los chunks.
//
// Tolerante: si el id no existe en el DOM aún (post no cargado o eliminado),
// no-op silencioso — el usuario verá la TL desde arriba como en x.com cuando
// un id viejo no está en cache.
//
// Detalle de la duplicación reply (ítem suelto + anidado): querySelector
// devuelve el primero en orden DOM, que con cron desc suele ser la
// versión "ítem propio" — el comportamiento esperado.
export function focusPostFromHash(behavior = 'smooth') {
  const id = location.hash.replace(/^#/, '');
  if (!id) return;
  const el = document.querySelector(`article.post[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior, block: 'center' });
  // Activación atómica: quitar .active de cualquier otro y poner a este.
  document.querySelectorAll('.post.active').forEach((other) => {
    if (other !== el) other.classList.remove('active');
  });
  el.classList.add('active');
  refreshThreadTranscribeBtn(el);
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
      ${renderPostFoot(p)}
    </div>
  `;

  if (p.poll) bindPollActions(el, p);
  bindPostClickToNavigate(el, p);
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
  if (isHidden(p.id)) return null;
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
