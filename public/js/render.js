// ----- renderizado de posts + bindings de UI -----

import { CSRF_HEADERS } from './state.js';
import { fmt, hoursAgo, escapeHtml, linkify, toast } from './utils.js';
import { isAuthed } from './auth.js';
import { notifyThreadChanged, getThreadRoot } from './rails.js';
import { makeInlineComposer } from './composer.js';
import { renderPostGallery, updateGalleryTranscript } from './gallery.js';
import { isHidden, hide } from './hidden.js';

// Barra de acciones del post (single view): se renderiza condicionalmente,
// se muestra siempre y opera sobre el propio post. La barra única por thread
// (timeline / replies anidados) se renderiza vía renderThreadActionsHtml.
//
//   ver twoitt → navega al permalink (sólo si !single)
//   responder  → composer inline (auth)
//   transcribir → sólo si el post tiene audio sin transcript (auth)
//   ocultar    → localStorage por-navegador (no afecta a otros devices)
//   borrar     → soft-delete server-side (recuperable desde papelera)
function renderSinglePostActions(p) {
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

// Barra única para un thread (timeline o replies). Renderiza TODOS los
// botones disponibles según auth; la visibilidad de "transcribir" se ajusta
// dinámicamente al activar un .post (según data-has-untranscribed del target).
// Los handlers leen el .post.active del thread como target.
function renderThreadActionsHtml() {
  const view = '<button class="vertwoitt-btn" type="button">ver twoitt</button>';
  const reply = isAuthed() ? '<button class="reply-btn" type="button">responder</button>' : '';
  const transcribe = isAuthed()
    ? '<button class="transcribe-btn" type="button" hidden>transcribir</button>'
    : '';
  const hideBtn = '<button class="hide-btn" type="button">ocultar</button>';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  return `<div class="post-actions">${view}${reply}${transcribe}${hideBtn}${del}</div>`;
}

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
// él o cualquier descendiente está .active. Evitamos un selector :has() en
// CSS porque la invalidación dinámica de :has() al quitar una clase está
// bugueada en algunas versiones de Chromium — el computed style se queda
// "pegado" al estado matcheante anterior. JS-driven es 100% fiable.
function syncThreadActiveFlags() {
  document.querySelectorAll('.thread > .post, #replies > .post').forEach((host) => {
    const has = host.classList.contains('active') || !!host.querySelector('.post.active');
    host.classList.toggle('thread-has-active', has);
  });
}

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

// Recalcula si el botón "transcribir" de la barra del thread debe verse,
// según el .post recién activado (dataset.hasUntranscribed). Se llama al
// activar; al cambiar target, se reevalúa siempre.
function refreshThreadTranscribeBtn(postEl) {
  const host = getThreadHost(postEl);
  const bar = host?.querySelector(':scope > .post-actions');
  const btn = bar?.querySelector('.transcribe-btn');
  if (!btn) return;
  btn.hidden = postEl.dataset.hasUntranscribed !== '1';
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

// ----- handlers compartidos (per-post o per-thread con target dinámico) -----

function navigateToPost(p) {
  location.href = `/post/${p.id}`;
}

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
  try {
    const res = await fetch(`/api/posts/${targetEl.dataset.id}/transcribe`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: CSRF_HEADERS,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
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
  } catch (err) {
    console.error('transcribe failed', err);
    toast('error al transcribir', 'error');
    btn.disabled = false;
    btn.textContent = original;
  }
}

function doHide(targetEl) {
  hide(targetEl.dataset.id);
  const parentPost = findLogicalParentPost(targetEl);
  const root = getThreadRoot(targetEl);
  // Mismo tratamiento al DOM que el delete: si es reply, sólo el .post;
  // si es root, todo el .thread. Notificamos para rails + contador.
  if (targetEl.closest('.thread-replies') || targetEl.closest('#replies')) {
    targetEl.remove();
  } else {
    targetEl.closest('.thread')?.remove() || targetEl.remove();
  }
  notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
  toast('post ocultado en este navegador', 'info');
}

async function doDelete(targetEl, { single = false } = {}) {
  if (!confirm('¿borrar este post?')) return;
  // capturar parent + thread root ANTES del DOM removal — closest() no
  // funciona en nodos detached.
  const parentPost = findLogicalParentPost(targetEl);
  const root = getThreadRoot(targetEl);
  const res = await fetch(`/api/posts/${targetEl.dataset.id}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: CSRF_HEADERS,
  });
  if (!res.ok) { toast('error al borrar', 'error'); return; }
  if (single) { location.href = '/'; return; }
  if (targetEl.closest('.thread-replies') || targetEl.closest('#replies')) {
    targetEl.remove();
  } else {
    targetEl.closest('.thread')?.remove() || targetEl.remove();
  }
  notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
}

// ----- binds para single root (barra propia, siempre visible) -----

function bindSinglePostActions(postEl, p) {
  const bar = postEl.querySelector(':scope > .post-actions');
  if (!bar) return;
  bar.querySelector('.reply-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openReplyComposer(postEl, p.id);
  });
  const tBtn = bar.querySelector('.transcribe-btn');
  if (tBtn) {
    tBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await doTranscribe(postEl, tBtn);
      // En single root el botón sólo aplica a este post; si terminó OK,
      // doTranscribe ya lo dejó hidden. Lo retiramos del flujo del flex.
      if (tBtn.hidden) tBtn.remove();
    });
  }
  bar.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await doDelete(postEl, { single: true });
  });
}

// ----- binds para la barra única por thread (target dinámico) -----

function bindThreadActions(threadRootEl) {
  const bar = threadRootEl.querySelector(':scope > .post-actions');
  if (!bar) return;
  const target = () => threadRootEl.querySelector('.post.clickable.active');

  bar.querySelector('.vertwoitt-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = target();
    if (t) navigateToPost({ id: t.dataset.id });
  });

  bar.querySelector('.reply-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = target();
    if (t) openReplyComposer(t, t.dataset.id);
  });

  const tBtn = bar.querySelector('.transcribe-btn');
  if (tBtn) {
    tBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = target();
      if (!t || tBtn.hidden) return;
      await doTranscribe(t, tBtn);
    });
  }

  bar.querySelector('.hide-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = target();
    if (t) doHide(t);
  });

  bar.querySelector('.delete-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const t = target();
    if (t) await doDelete(t, { single: false });
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
  }
  return el;
}
