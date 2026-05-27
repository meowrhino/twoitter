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
import { notifyThreadChanged, getThreadRoot } from './rails.js';
import { makeInlineComposer } from './composer.js';
import { updateGalleryTranscript } from './gallery.js';
import { hide } from './hidden.js';

// ----- render HTML de las barras -----

// Barra del single root: condicional, sólo botones que aplican al propio
// post; "ver twoitt" no porque ya estamos en su single view; "ocultar" no
// porque ocultar el post principal te dejaría con la página en blanco.
export function renderSinglePostActions(p) {
  const reply = isAuthed() ? '<button class="reply-btn" type="button">responder</button>' : '';
  const audioMedia = (p.media || []).filter((m) => m.kind === 'audio');
  const hasUntranscribed = audioMedia.some((m) => !m.transcript);
  const transcribe = isAuthed() && hasUntranscribed
    ? '<button class="transcribe-btn" type="button">transcribir</button>'
    : '';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  if (!reply && !transcribe && !del) return '';
  return `<div class="post-actions">${reply}${transcribe}${del}</div>`;
}

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

// ----- handlers compartidos -----

function openReplyComposer(targetEl, parentId) {
  const existing = targetEl.querySelector(':scope > .reply-inline');
  if (existing) { existing.remove(); return; }
  const composer = makeInlineComposer(targetEl, parentId);
  // El composer va DIRECTAMENTE detrás del .post-body. Si lo apendieras al
  // .post a secas, caería tras .thread-replies / .post-actions, descolocado.
  const body = targetEl.querySelector(':scope > .post-body');
  if (body) body.after(composer);
  else targetEl.prepend(composer);
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

async function doDelete(targetEl, { single = false } = {}) {
  if (!confirm('¿borrar este post?')) return;
  // capturar parent + thread root ANTES del DOM removal — closest() no
  // funciona en nodos detached.
  const parentPost = findLogicalParentPost(targetEl);
  const root = getThreadRoot(targetEl);
  const { ok } = await api(`/api/posts/${targetEl.dataset.id}`, { method: 'DELETE' });
  if (!ok) { toast('error al borrar', 'error'); return; }
  if (single) { location.href = '/'; return; }
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

// Single-view: la barra opera siempre sobre el propio postEl. No hay vertwoitt
// (ya estamos en su single). transcribe se autodestruye tras éxito porque sólo
// aplica a este post.
export function bindSinglePostActions(postEl, p) {
  const bar = postEl.querySelector(':scope > .post-actions');
  if (!bar) return;
  bindButtonsOnBar(bar, {
    '.reply-btn': () => openReplyComposer(postEl, p.id),
    '.transcribe-btn': async (btn) => {
      await doTranscribe(postEl, btn);
      if (btn.hidden) btn.remove();
    },
    '.delete-btn': () => doDelete(postEl, { single: true }),
  });
}

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
    '.vertwoitt-btn': () => {
      const t = target();
      if (t) location.href = `/post/${t.dataset.id}`;
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
      if (t) return doDelete(t, { single: false });
    },
  });
}
