// ----- barra de acciones del post: render HTML + bindings + handlers -----
//
// Antes vivía dentro de render.js. Lo extrajimos aquí porque el módulo
// crecía con tres responsabilidades distintas:
//   - render del HTML de los posts (lo que renderPost/renderThread hace)
//   - flujo de activación/click (bindPostClickToNavigate, syncThreadActiveFlags)
//   - acciones del usuario sobre un post (responder, ocultar, borrar, transcribir)
// Este archivo se queda con la tercera. render.js le delega via imports.

import { api } from './api.js';
import { toast, escapeHtml, linkify } from './utils.js';
import { isAuthed } from './auth.js';
import { notifyThreadChanged, getThreadRoot, releaseRail } from './rails.js';
import { makeInlineComposer } from './inline-composer.js';
import { hide, unhide, markPostHidden, unmarkPostHidden } from './hidden.js';
import { readMedia } from './gallery-core.js';
import { updateGalleryTranscript, updateGalleryTranscriptEdit } from './gallery.js';
import { fmtTranscribedAt } from './audio-player.js';

// ----- render HTML de las barras -----

// Barra única por thread (timeline / replies anidados). Renderiza los botones
// disponibles según auth. "transcribir" actúa sobre el audio que esté activo en
// la galería del post (toggle entre audios → cada uno se transcribe por
// separado); se muestra/oculta dinámicamente según ese audio
// (refreshThreadTranscribeBtn).
export function renderThreadActionsHtml() {
  const view = '<button class="vertwoitt-btn" type="button">ver twoitt</button>';
  const reply = isAuthed() ? '<button class="reply-btn" type="button">responder</button>' : '';
  const transcribe = isAuthed()
    ? '<button class="transcribe-btn" type="button" hidden>transcribir</button>'
    : '';
  // ocultar/desocultar: per-navegador (localStorage), por eso disponibles sin
  // auth. Uno de los dos se muestra según el estado del .post.active vigente
  // (refreshThreadHideBtn). Por defecto se ofrece "ocultar".
  const hideBtn = '<button class="hide-btn" type="button">ocultar</button>';
  const unhideBtn = '<button class="unhide-btn" type="button" hidden>desocultar</button>';
  const edit = isAuthed() ? '<button class="edit-btn" type="button">editar</button>' : '';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  return `<div class="post-actions">${view}${reply}${transcribe}${edit}${hideBtn}${unhideBtn}${del}</div>`;
}

// El audio que la galería del post tiene AHORA en el stage (o null si el medio
// activo no es audio / no hay galería). Lo usan refreshThreadTranscribeBtn y
// doTranscribe para saber sobre qué nota actuar.
function activeStageAudio(postEl) {
  const gallery = postEl?.querySelector(':scope > .post-body .gallery');
  if (!gallery) return null;
  const stage = gallery.querySelector(':scope > .stage');
  const idx = Number(stage?.dataset.index || 0);
  const m = readMedia(gallery)[idx];
  return m && m.kind === 'audio' ? { ...m, gallery } : null;
}

// Muestra "transcribir" en la barra del thread sólo si el audio activo del post
// existe y aún no está transcrito. Se re-llama al activar un post (render.js) y
// al cambiar de audio en la galería (evento twoitter:gallery-swapped).
export function refreshThreadTranscribeBtn(postEl) {
  const host = getThreadHost(postEl);
  const btn = host?.querySelector(':scope > .post-actions .transcribe-btn');
  if (!btn) return;
  const audio = activeStageAudio(postEl);
  btn.hidden = !(audio && !audio.transcript);
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

// Padre lógico de un .post para ajustar su contador "N resp": el .post ancestro.
function findLogicalParentPost(postEl) {
  return postEl.parentElement?.closest('.post') ?? null;
}

// Escalona la entrada/salida de los botones de una barra al ritmo del rail.
// Setea en cada botón VISIBLE dos índices que el CSS usa como retardo:
//   --si → índice desde la DERECHA (0 = el más a la derecha): apertura en
//          cascada derecha→izquierda, sincronizada con el rail creciendo.
//   --sc → índice desde la IZQUIERDA: cierre simétrico inverso (los de la
//          izquierda se van primero) cuando el rail se recoge.
// Se recalcula en cada activación porque "transcribir" y "ocultar/desocultar" se
// muestran/ocultan según el target: contar sólo los visibles evita un hueco en
// mitad de la cascada. Debe llamarse DESPUÉS de refreshThread{Transcribe,Hide}Btn
// (que fijan qué se ve).
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

// Transcribe el audio ACTIVO del post (el que esté en el stage de su galería).
// En un twoitt con varias notas: toggle al audio que quieras → transcribir; cada
// una se guarda por separado. Idempotente en backend (cacheado). Pinta el texto
// + la hora bajo la nota y refresca el botón (se oculta si ya está transcrita).
async function doTranscribe(postEl, btn) {
  if (btn.disabled) return;
  const audio = activeStageAudio(postEl);
  if (!audio) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'transcribiendo…';
  const { ok, data } = await api(`/api/media/${audio.id}/transcribe`, { method: 'POST' });
  if (!ok || !data?.transcript) {
    toast(data?.error || 'error al transcribir', 'error');
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  updateGalleryTranscript(audio.gallery, audio.id, data.transcript, data.transcribed_at);
  btn.disabled = false;
  btn.textContent = original;
  refreshThreadTranscribeBtn(postEl);
}

// ----- corregir transcripción (inline, por audio) -----
//
// El botón "corregir" vive DENTRO del bloque .audio-transcript de cada nota
// (no en la barra del thread, a diferencia de "transcribir"): cada audio de
// un twoitt tiene el suyo. Se abre/cierra/guarda con el mismo patrón que
// openEdit/saveEdit (texto del post), pero delegado globalmente desde
// document (ensureGlobalListeners) porque el bloque vive dentro del stage de
// la galería, que se recrea en cada swap.

function findTranscriptTextEls(block) {
  return {
    text: block.querySelector(':scope > .transcript-text'),
    time: block.querySelector(':scope > .transcript-time'),
    actions: block.querySelector(':scope > .transcript-actions'),
  };
}

function closeTranscriptEdit(block) {
  if (!block) return;
  const box = block.querySelector(':scope > .edit-inline');
  if (box) box.remove();
  const { text, time, actions } = findTranscriptTextEls(block);
  if (text) text.hidden = false;
  if (time) time.hidden = false;
  if (actions) actions.hidden = false;
}

function openTranscriptEdit(correctBtn) {
  const block = correctBtn.closest('.audio-transcript');
  if (!block || block.querySelector(':scope > .edit-inline')) return;
  const gallery = block.closest('.gallery');
  const mediaId = Number(block.dataset.mediaId);
  const media = readMedia(gallery).find((m) => m.kind === 'audio' && m.id === mediaId);
  if (!media) return;

  const { text, time, actions } = findTranscriptTextEls(block);
  if (text) text.hidden = true;
  if (time) time.hidden = true;
  if (actions) actions.hidden = true;

  const box = document.createElement('div');
  box.className = 'edit-inline';
  box.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(media.transcript || '')}</textarea>
    <div class="edit-actions">
      <button type="button" class="transcript-edit-cancel link-btn">cancelar</button>
      <button type="button" class="transcript-edit-save btn-primary">guardar</button>
    </div>
  `;
  block.appendChild(box);
  const textarea = box.querySelector('.edit-textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function saveTranscriptEdit(saveBtn) {
  if (saveBtn.disabled) return;
  const box = saveBtn.closest('.edit-inline');
  const block = saveBtn.closest('.audio-transcript');
  const textarea = box?.querySelector('.edit-textarea');
  if (!box || !block || !textarea) return;
  const mediaId = block.dataset.mediaId;
  saveBtn.disabled = true;
  const { ok, data } = await api(`/api/media/${mediaId}/transcript`, {
    method: 'PATCH',
    body: { transcript: textarea.value },
  });
  if (!ok || !data) {
    toast(data?.error || 'error al corregir', 'error');
    saveBtn.disabled = false;
    return;
  }
  const gallery = block.closest('.gallery');
  updateGalleryTranscriptEdit(gallery, mediaId, data.transcript, data.transcript_original, data.transcript_edited_at);
}

// Alterna entre el transcript corregido (actual) y el original de Whisper —
// ambos ya vienen en el payload de la galería (readMedia), sin fetch.
function toggleTranscriptOriginal(toggleBtn) {
  const block = toggleBtn.closest('.audio-transcript');
  if (!block) return;
  const gallery = block.closest('.gallery');
  const mediaId = Number(block.dataset.mediaId);
  const media = readMedia(gallery).find((m) => m.kind === 'audio' && m.id === mediaId);
  if (!media || !media.transcript_original) return;
  const { text } = findTranscriptTextEls(block);
  if (!text) return;
  const showingOriginal = toggleBtn.dataset.showing === 'original';
  text.textContent = showingOriginal ? media.transcript : media.transcript_original;
  toggleBtn.dataset.showing = showingOriginal ? 'edited' : 'original';
  toggleBtn.textContent = showingOriginal ? 'ver original' : 'ver corregida';
}

// Muestra "ocultar" o "desocultar" en la barra del thread según si el .post
// objetivo está oculto. Se llama al activar un post (render.js) para que la
// barra refleje su estado.
export function refreshThreadHideBtn(postEl) {
  const host = getThreadHost(postEl);
  const bar = host?.querySelector(':scope > .post-actions');
  if (!bar) return;
  const isHiddenPost = postEl.classList.contains('post-hidden');
  const hideB = bar.querySelector('.hide-btn');
  const unhideB = bar.querySelector('.unhide-btn');
  if (hideB) hideB.hidden = isHiddenPost;
  if (unhideB) unhideB.hidden = !isHiddenPost;
}

// Ocultar: ya NO quita del DOM. Colapsa el post (y todas sus copias en el feed,
// porque el mismo twoitt sale como ítem suelto + anidado) a un placeholder
// revelable. "desocultar" lo revierte.
function doHide(targetEl) {
  const id = targetEl.dataset.id;
  hide(id);
  // Colapsar a stub TODAS las copias (sale como ítem suelto + anidado) y
  // DESACTIVARLAS: si el post quedara activo, el rail seguiría midiendo el stub
  // (queda colgando) y el ResizeObserver apuntando a un nodo ya colapsado.
  // Quedando inactivo, releaseRail lo suelta y se ve un stub limpio. Para
  // recuperarlo: click en el stub → revela + activa → "desocultar" en la barra.
  document.querySelectorAll(`.post[data-id="${CSS.escape(id)}"]`).forEach((el) => {
    el.classList.remove('active');
    markPostHidden(el);
  });
  releaseRail();
  toast('post ocultado en este navegador', 'info');
}

function doUnhide(targetEl) {
  const id = targetEl.dataset.id;
  unhide(id);
  document.querySelectorAll(`.post[data-id="${CSS.escape(id)}"]`).forEach(unmarkPostHidden);
  refreshThreadHideBtn(targetEl); // vuelve a "ocultar"
  toast('post visible de nuevo', 'info');
}

// ----- editar (texto inline) -----

function findPostText(targetEl) {
  return targetEl.querySelector(':scope > .post-body > .post-text');
}

function findPostEdited(targetEl) {
  return targetEl.querySelector(':scope > .post-body > .post-edited');
}

// Rellena/actualiza in-place el sello "editado el ..." tras un PATCH, sin
// re-renderizar el post (mismo patrón que updateGalleryTranscript).
function updatePostEditedStamp(targetEl, editedAt) {
  const stamp = findPostEdited(targetEl);
  if (!stamp || !editedAt) return;
  stamp.hidden = false;
  stamp.title = editedAt;
  stamp.textContent = `editado el ${fmtTranscribedAt(editedAt)}`;
}

function closeEditBox(targetEl) {
  const box = targetEl.querySelector(':scope > .post-body > .edit-inline');
  if (box) box.remove();
  const textEl = findPostText(targetEl);
  if (textEl) textEl.hidden = false;
}

// Convierte .post-text en un textarea editable con guardar/cancelar. Toggle-off
// si ya había uno abierto en este post (mismo patrón que openReplyComposer).
function openEdit(targetEl) {
  const existing = targetEl.querySelector(':scope > .post-body > .edit-inline');
  if (existing) { closeEditBox(targetEl); return; }
  const textEl = findPostText(targetEl);
  if (!textEl) return;

  const box = document.createElement('div');
  box.className = 'edit-inline';
  box.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(targetEl.dataset.text || '')}</textarea>
    <div class="edit-actions">
      <button type="button" class="edit-cancel link-btn">cancelar</button>
      <button type="button" class="edit-save btn-primary">guardar</button>
    </div>
  `;
  textEl.hidden = true;
  textEl.after(box);

  const textarea = box.querySelector('.edit-textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  box.querySelector('.edit-cancel').addEventListener('click', (e) => {
    e.stopPropagation();
    closeEditBox(targetEl);
  });
  box.querySelector('.edit-save').addEventListener('click', async (e) => {
    e.stopPropagation();
    await saveEdit(targetEl, box, textarea);
  });
}

async function saveEdit(targetEl, box, textarea) {
  const saveBtn = box.querySelector('.edit-save');
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  const { ok, data } = await api(`/api/posts/${targetEl.dataset.id}`, {
    method: 'PATCH',
    body: { text: textarea.value },
  });
  if (!ok || !data) {
    toast(data?.error || 'error al editar', 'error');
    saveBtn.disabled = false;
    return;
  }
  targetEl.dataset.text = data.text || '';
  const textEl = findPostText(targetEl);
  if (textEl) textEl.innerHTML = linkify(data.text || '');
  updatePostEditedStamp(targetEl, data.edited_at);
  closeEditBox(targetEl);
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
  if (targetEl.closest('.thread-replies')) {
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

// Al cambiar de audio en una galería (twoitter:gallery-swapped), "transcribir"
// depende del nuevo audio activo → reevaluar. Sólo si ese post es el activo (la
// barra es única por thread y refleja el .active). Listener global, una vez.
let swapWired = false;
function ensureGlobalListeners() {
  if (swapWired) return;
  swapWired = true;
  document.addEventListener('twoitter:gallery-swapped', (e) => {
    const postEl = e.detail?.gallery?.closest?.('.post');
    if (postEl?.classList.contains('active')) refreshThreadTranscribeBtn(postEl);
  });

  // Botones dentro de .audio-transcript ("corregir" / "ver original" / guardar
  // o cancelar la corrección): delegado desde document porque el bloque vive
  // dentro del stage de la galería, que se recrea en cada swap.
  document.addEventListener('click', async (e) => {
    const correctBtn = e.target.closest('.transcript-correct-btn');
    if (correctBtn) { e.stopPropagation(); openTranscriptEdit(correctBtn); return; }
    const toggleBtn = e.target.closest('.transcript-toggle-btn');
    if (toggleBtn) { e.stopPropagation(); toggleTranscriptOriginal(toggleBtn); return; }
    const cancelBtn = e.target.closest('.transcript-edit-cancel');
    if (cancelBtn) { e.stopPropagation(); closeTranscriptEdit(cancelBtn.closest('.audio-transcript')); return; }
    const saveBtn = e.target.closest('.transcript-edit-save');
    if (saveBtn) { e.stopPropagation(); await saveTranscriptEdit(saveBtn); return; }
  });
}

// Thread bar: target dinámico (el .post.active vigente). Si el root del thread
// es él mismo .active, querySelector no lo matchearía (sólo busca descendientes),
// así que comprobamos el root explícitamente con .matches() antes.
export function bindThreadActions(threadRootEl) {
  ensureGlobalListeners();
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
    '.edit-btn': () => {
      const t = target();
      if (t) openEdit(t);
    },
    '.hide-btn': () => {
      const t = target();
      if (t) doHide(t);
    },
    '.unhide-btn': () => {
      const t = target();
      if (t) doUnhide(t);
    },
    '.delete-btn': () => {
      const t = target();
      if (t) return doDelete(t);
    },
  });
}
