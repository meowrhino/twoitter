// ----- barra de acciones del post: render HTML + bindings + handlers -----
//
// Antes vivía dentro de render.js. Lo extrajimos aquí porque el módulo
// crecía con tres responsabilidades distintas:
//   - render del HTML de los posts (lo que renderPost/renderThread hace)
//   - flujo de activación/click (bindPostClickToNavigate, syncThreadActiveFlags)
//   - acciones del usuario sobre un post (responder, ocultar, borrar, transcribir)
// Este archivo se queda con la tercera. render.js le delega via imports.

import { api } from './api.js';
import { toast } from './utils.js';
import { isAuthed } from './auth.js';
import { notifyThreadChanged, getThreadRoot, releaseRail } from './rails.js';
import { makeInlineComposer } from './composer.js';
import { updateGalleryTranscript } from './gallery.js';
import { hide } from './hidden.js';

// ----- render HTML de las barras -----

// Barra única por thread (timeline / replies anidados). Renderiza TODOS los
// botones disponibles según auth; "transcribir" se muestra/oculta dinámicamente
// según el .post.active vigente (refreshThreadTranscribeBtn).
export function renderThreadActionsHtml() {
  const view = '<button class="vertwoitt-btn" type="button">ver twoitt</button>';
  const reply = isAuthed() ? '<button class="reply-btn" type="button">responder</button>' : '';
  const transcribe = isAuthed()
    ? '<button class="transcribe-btn" type="button" hidden>transcribir</button>'
    : '';
  const hideBtn = '<button class="hide-btn" type="button">ocultar</button>';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  return `<div class="post-actions">${view}${reply}${transcribe}${hideBtn}${del}</div>`;
}

// ----- helpers de navegación por el árbol -----

// Sube por el árbol de .post hasta el más externo (el root del thread,
// donde vive la barra de acciones única).
function getThreadHost(postEl) {
  let host = postEl;
  let cur = postEl.parentElement;
  while (cur) {
    const ancestor = cur.closest('.post');
    if (!ancestor) break;
    host = ancestor;
    cur = ancestor.parentElement;
  }
  return host;
}

// En single, los replies de nivel 1 cuelgan de #replies (no de un .post):
// su padre lógico para "N resp" es el post principal en #postContainer.
function findLogicalParentPost(postEl) {
  let parent = postEl.parentElement?.closest('.post');
  if (!parent && postEl.closest('#replies')) {
    parent = document.querySelector('#postContainer > .post');
  }
  return parent;
}

// Llamada por render.js cuando un .post pasa a .active: actualiza si el
// botón "transcribir" de la barra del thread debe verse (depende del flag
// dataset.hasUntranscribed del nuevo target).
export function refreshThreadTranscribeBtn(postEl) {
  const host = getThreadHost(postEl);
  const bar = host?.querySelector(':scope > .post-actions');
  const btn = bar?.querySelector('.transcribe-btn');
  if (!btn) return;
  btn.hidden = postEl.dataset.hasUntranscribed !== '1';
}

// Escalona la entrada/salida de los botones de una barra al ritmo del rail.
// Setea en cada botón VISIBLE dos índices que el CSS usa como retardo:
//   --si → índice desde la DERECHA (0 = el más a la derecha): apertura en
//          cascada derecha→izquierda, sincronizada con el rail creciendo.
//   --sc → índice desde la IZQUIERDA: cierre simétrico inverso (los de la
//          izquierda se van primero) cuando el rail se recoge.
// Se recalcula en cada activación porque "transcribir" se muestra/oculta según
// el target: contar sólo los visibles evita un hueco en mitad de la cascada.
// Debe llamarse DESPUÉS de refreshThreadTranscribeBtn (que fija qué se ve).
export function staggerActionButtons(bar) {
  if (!bar) return;
  const btns = [...bar.children].filter((b) => b.tagName === 'BUTTON' && !b.hidden);
  const n = btns.length;
  btns.forEach((b, i) => {
    b.style.setProperty('--si', String(n - 1 - i)); // desde la derecha (apertura)
    b.style.setProperty('--sc', String(i));          // desde la izquierda (cierre)
  });
}

// ----- handlers compartidos -----

function openReplyComposer(targetEl, parentId) {
  const existing = targetEl.querySelector(':scope > .reply-inline');
  // Toggle-off: reutiliza el botón "cancelar" del composer abierto, que encoge
  // con animación (en lockstep con el rail) y luego lo quita.
  if (existing) { existing.querySelector('.cancel')?.click(); return; }
  const composer = makeInlineComposer(targetEl, parentId);
  // El composer va DIRECTAMENTE detrás del .post-body. Si lo apendieras al
  // .post a secas, caería tras .thread-replies / .post-actions, descolocado.
  const body = targetEl.querySelector(':scope > .post-body');
  if (body) body.after(composer);
  else targetEl.prepend(composer);
  // El rail lo gestiona la animación de apertura del composer (animateComposerOpen,
  // disparada vía microtask en makeInlineComposer): mientras el recuadro crece,
  // lockstepRail lo pega frame a frame. No hace falta repintar aquí.
}

async function doTranscribe(targetEl, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'transcribiendo…';
  const { ok, data } = await api(`/api/posts/${targetEl.dataset.id}/transcribe`, { method: 'POST' });
  if (!ok) {
    toast(data?.error || 'error al transcribir', 'error');
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  const gallery = targetEl.querySelector(':scope > .post-body .gallery');
  updateGalleryTranscript(gallery, data.transcript);
  targetEl.dataset.hasUntranscribed = '0';
  btn.disabled = false;
  btn.textContent = original;
  btn.hidden = true;
}

function doHide(targetEl) {
  hide(targetEl.dataset.id);
  removeFromDom(targetEl);
  toast('post ocultado en este navegador', 'info');
}

async function doDelete(targetEl) {
  if (!confirm('¿borrar este post?')) return;
  // capturar parent + thread root ANTES del DOM removal — closest() no
  // funciona en nodos detached.
  const parentPost = findLogicalParentPost(targetEl);
  const root = getThreadRoot(targetEl);
  const { ok } = await api(`/api/posts/${targetEl.dataset.id}`, { method: 'DELETE' });
  if (!ok) { toast('error al borrar', 'error'); return; }
  removeFromDom(targetEl, { parentPost, root });
}

// Borrado de DOM compartido entre doHide y doDelete: si es reply, sólo el
// .post; si es root, todo el .thread (para que no se quede una caja vacía).
// Notifica al sistema para que actualice contador y rails.
function removeFromDom(targetEl, ctx = null) {
  const parentPost = ctx?.parentPost ?? findLogicalParentPost(targetEl);
  const root = ctx?.root ?? getThreadRoot(targetEl);
  if (targetEl.closest('.thread-replies') || targetEl.closest('#replies')) {
    targetEl.remove();
  } else {
    targetEl.closest('.thread')?.remove() || targetEl.remove();
  }
  // Si el twoitt borrado/ocultado era el .active (o su thread), el rail amarillo
  // quedaría colgado y el ResizeObserver apuntando a un nodo detached. releaseRail
  // lo suelta; no-op si seguía habiendo otro .active (se borró un twoitt distinto).
  releaseRail();
  notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
}

// ----- helper de binding -----

// Helper para registrar handlers de click sobre los botones de una .post-actions
// bar. Las reglas son { '.x-btn': handler }. El helper:
//   - hace querySelector + addEventListener opcional (no falla si el botón
//     no existe, p.ej. cuando el usuario no está authed)
//   - mete e.stopPropagation() automáticamente (los botones nunca quieren
//     que el click llegue al .post de fondo y dispare activate)
//   - soporta handlers async (los await por si después hace algo más)
function bindButtonsOnBar(bar, rules) {
  for (const [selector, handler] of Object.entries(rules)) {
    const btn = bar.querySelector(selector);
    if (!btn) continue;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handler(btn, e);
    });
  }
}

// ----- binds concretos -----

// Thread bar: target dinámico (el .post.active vigente). Si el root del thread
// es él mismo .active, querySelector no lo matchearía (sólo busca descendientes),
// así que comprobamos el root explícitamente con .matches() antes.
export function bindThreadActions(threadRootEl) {
  const bar = threadRootEl.querySelector(':scope > .post-actions');
  if (!bar) return;
  const target = () =>
    threadRootEl.matches('.post.clickable.active')
      ? threadRootEl
      : threadRootEl.querySelector('.post.clickable.active');

  bindButtonsOnBar(bar, {
    // "ver twoitt" ya no navega a /post/:id (vista eliminada). Pone el hash
    // al id del post; el listener de hashchange (en render.js) hace el
    // scrollIntoView + focus. Mismo resultado, sin recargar la página.
    '.vertwoitt-btn': () => {
      const t = target();
      if (t) location.hash = '#' + t.dataset.id;
    },
    '.reply-btn': () => {
      const t = target();
      if (t) openReplyComposer(t, t.dataset.id);
    },
    '.transcribe-btn': async (btn) => {
      const t = target();
      if (!t || btn.hidden) return;
      await doTranscribe(t, btn);
    },
    '.hide-btn': () => {
      const t = target();
      if (t) doHide(t);
    },
    '.delete-btn': () => {
      const t = target();
      if (t) return doDelete(t);
    },
  });
}
