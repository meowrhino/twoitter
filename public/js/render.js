// ----- renderizado de posts + bindings de UI -----

import { CSRF_HEADERS } from './state.js';
import { fmt, hoursAgo, escapeHtml, linkify, toast } from './utils.js';
import { isAuthed } from './auth.js';
import { notifyThreadChanged, getThreadRoot } from './rails.js';
import { makeInlineComposer } from './composer.js';

// ----- templates puros (sin side effects, sin DOM) -----

function renderPostMedia(p) {
  if (p.media.length === 0) return '';
  const items = p.media.map((m) => {
    if (m.kind === 'image') {
      return `<div class="item"><img src="/r2/${m.r2_key}" loading="lazy"></div>`;
    }
    const poster = m.thumb_key ? ` poster="/r2/${m.thumb_key}"` : '';
    return `<div class="item"><video src="/r2/${m.r2_key}" controls preload="metadata"${poster}></video></div>`;
  }).join('');
  return `<div class="post-media count-${Math.min(p.media.length, 4)}">${items}</div>`;
}

// Wrapper de "responder/borrar". Vive FUERA de .post-body, como hijo directo
// de .post: CSS lo ancla absoluto a la derecha del .post, alineado con el
// final del rail vertical (via --rail-bottom, que mantiene extendRails()).
// Siempre visible cuando hay sesión — no depende de hover.
function renderPostActions(single) {
  const reply = isAuthed() && !single ? '<button class="reply-btn" type="button">responder</button>' : '';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  if (!reply && !del) return '';
  return `<div class="post-actions">${reply}${del}</div>`;
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

// click + keyboard navegan al permalink. role=link + tabindex=0 + aria-label
// hacen el post alcanzable por teclado y lectores de pantalla.
//
// En touch, el primer tap activa el post (clase .tapped → CSS muestra
// post-actions). Re-tap del mismo post navega al permalink. Tap fuera
// desactiva (listener global en setupTapToActivate). Hover (desktop)
// muestra los botones sin necesidad de tap.
function bindPostClickToNavigate(postEl, p) {
  postEl.setAttribute('role', 'link');
  postEl.setAttribute('tabindex', '0');
  postEl.setAttribute('aria-label', `abrir post #${p.id}`);
  const go = (e) => {
    if (e.target.closest('a, button, video, .composer')) return;
    if (e.target.closest('.post') !== postEl) return;
    // En dispositivos sin hover, primer tap activa, segundo navega.
    const isTouch = matchMedia('(hover: none)').matches;
    if (isTouch && !postEl.classList.contains('tapped')) {
      document.querySelectorAll('.post.tapped').forEach((el) => {
        if (el !== postEl) el.classList.remove('tapped');
      });
      postEl.classList.add('tapped');
      return;
    }
    location.href = `/post/${p.id}`;
  };
  postEl.addEventListener('click', go);
  postEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target !== postEl) return; // ignorar si el focus está en un hijo interactivo
    e.preventDefault();
    location.href = `/post/${p.id}`;
  });
  postEl.classList.add('clickable');
}

// Global: tap fuera de cualquier .post o tap en un .post distinto al
// .tapped actual → quitar la clase para que esconda sus post-actions.
// Se llama una sola vez desde el entry point.
export function setupTapToActivate() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('.post-actions')) return; // dejar que el botón actúe
    const post = e.target.closest?.('.post.clickable');
    document.querySelectorAll('.post.tapped').forEach((el) => {
      if (el !== post) el.classList.remove('tapped');
    });
  }, true);
}

function bindReplyButton(postEl, p) {
  const reply = postEl.querySelector(':scope > .post-actions .reply-btn');
  if (!reply) return;
  reply.onclick = (e) => {
    e.stopPropagation();
    const existing = postEl.querySelector(':scope > .reply-inline');
    if (existing) { existing.remove(); return; }
    const composer = makeInlineComposer(postEl, p.id);
    const nested = postEl.querySelector(':scope > .thread-replies');
    if (nested) postEl.insertBefore(composer, nested);
    else postEl.appendChild(composer);
  };
}

function bindDeleteButton(postEl, p, single) {
  const del = postEl.querySelector(':scope > .post-actions .delete-btn');
  if (!del) return;
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿borrar este post?')) return;
    // capturar parent + thread root ANTES del DOM removal — closest() no
    // funciona en nodos detached.
    const parentPost = findLogicalParentPost(postEl);
    const root = getThreadRoot(postEl);
    const res = await fetch(`/api/posts/${p.id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: CSRF_HEADERS,
    });
    if (!res.ok) { toast('error al borrar', 'error'); return; }
    if (single) { location.href = '/'; return; }
    if (postEl.closest('.thread-replies') || postEl.closest('#replies')) {
      postEl.remove();
    } else {
      postEl.closest('.thread')?.remove() || postEl.remove();
    }
    notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
  };
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

// ----- renderPost / renderThread -----

export function renderPost(p, { single = false } = {}) {
  const el = document.createElement('article');
  el.className = 'post';
  el.dataset.id = p.id;
  // source of truth para updateReplyCount tras add/delete
  el.dataset.replyCount = String(p.reply_count || 0);
  el.innerHTML = `
    <div class="post-body">
      <div class="post-text">${linkify(p.text || '')}</div>
      ${renderPostMedia(p)}
      ${renderPostFoot(p)}
    </div>
    ${renderPostActions(single)}
  `;
  if (!single) bindPostClickToNavigate(el, p);
  bindReplyButton(el, p);
  bindDeleteButton(el, p, single);
  return el;
}

// Recursivo: renderiza un post + sus replies anidados.
export function renderThread(p) {
  const el = renderPost(p);
  if (p.replies && p.replies.length) {
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    for (const child of p.replies) nested.appendChild(renderThread(child));
    el.appendChild(nested);
  }
  return el;
}
