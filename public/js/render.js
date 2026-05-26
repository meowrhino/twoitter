// ----- renderizado de posts + bindings de UI -----

import { CSRF_HEADERS } from './state.js';
import { fmt, hoursAgo, escapeHtml, linkify, toast } from './utils.js';
import { isAuthed } from './auth.js';
import { notifyThreadChanged, getThreadRoot } from './rails.js';
import { makeInlineComposer } from './composer.js';
import { renderPostGallery, updateGalleryTranscript } from './gallery.js';
import { isHidden, hide } from './hidden.js';

// Wrapper de acciones del post. Vive FUERA de .post-body, como hijo directo
// de .post: CSS lo ancla absoluto a la derecha del .post, alineado con el
// final del rail vertical (via --rail-bottom, que mantiene extendRails()).
// Aparecen al activar el post (click en el .post-body añade .active).
//
//   ver twoitt → navega al permalink (sólo en feed, no en single)
//   responder  → composer inline (sólo en feed, no en single)
//   transcribir → sólo si el post tiene audio sin transcript (auth)
//   ocultar    → localStorage por-navegador (no afecta a otros devices)
//   borrar     → soft-delete server-side (recuperable desde papelera)
//
// "ocultar" está disponible incluso sin sesión: cualquiera puede esconder
// posts molestos de su feed local. "borrar" y "transcribir" requieren auth.
function renderPostActions(p, single) {
  const view = !single ? '<button class="vertwoitt-btn" type="button">ver twoitt</button>' : '';
  const reply = isAuthed() && !single ? '<button class="reply-btn" type="button">responder</button>' : '';
  // Sólo mostrar "transcribir" si:
  //  - hay sesión (vamos a llamar a Workers AI, no queremos que un visitante
  //    queme la cuota)
  //  - el post tiene al menos un media de tipo audio
  //  - ningún audio ya tiene transcript (si los hay todos, no hace falta)
  const audioMedia = (p.media || []).filter((m) => m.kind === 'audio');
  const hasUntranscribed = audioMedia.some((m) => !m.transcript);
  const transcribe = isAuthed() && hasUntranscribed
    ? '<button class="transcribe-btn" type="button">transcribir</button>'
    : '';
  const hideBtn = !single ? '<button class="hide-btn" type="button">ocultar</button>' : '';
  const del = isAuthed() ? '<button class="delete-btn" type="button">borrar</button>' : '';
  if (!view && !reply && !transcribe && !hideBtn && !del) return '';
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
// .active al .post más interno bajo el cursor → CSS muestra .post-actions
// con slide-in. Click fuera (o en otro .post) lo quita. Para navegar al
// permalink, el usuario pulsa el botón "ver twoitt" (renderPostActions).
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
  }, true);
}

function bindViewTwoittButton(postEl, p) {
  const view = postEl.querySelector(':scope > .post-actions .vertwoitt-btn');
  if (!view) return;
  view.onclick = (e) => {
    e.stopPropagation();
    location.href = `/post/${p.id}`;
  };
}

function bindReplyButton(postEl, p) {
  const reply = postEl.querySelector(':scope > .post-actions .reply-btn');
  if (!reply) return;
  reply.onclick = (e) => {
    e.stopPropagation();
    const existing = postEl.querySelector(':scope > .reply-inline');
    if (existing) { existing.remove(); return; }
    const composer = makeInlineComposer(postEl, p.id);
    // El composer cae JUSTO debajo de la barra de acciones (que es donde
    // está el botón "responder" que lo abrió) y por encima de los replies
    // anidados. Si por alguna razón no hay barra (single-view sin botones),
    // cae a body.after().
    const actions = postEl.querySelector(':scope > .post-actions');
    if (actions) actions.after(composer);
    else {
      const body = postEl.querySelector(':scope > .post-body');
      if (body) body.after(composer);
      else postEl.prepend(composer);
    }
  };
}

function bindHideButton(postEl, p, single) {
  const hideBtn = postEl.querySelector(':scope > .post-actions .hide-btn');
  if (!hideBtn) return;
  hideBtn.onclick = (e) => {
    e.stopPropagation();
    hide(p.id);
    // Mismo tratamiento al DOM que el delete: si es reply, sólo el .post;
    // si es root, todo el .thread. Notificamos para rails + contador.
    const parentPost = findLogicalParentPost(postEl);
    const root = getThreadRoot(postEl);
    if (postEl.closest('.thread-replies') || postEl.closest('#replies')) {
      postEl.remove();
    } else {
      postEl.closest('.thread')?.remove() || postEl.remove();
    }
    notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
    toast('post ocultado en este navegador', 'info');
  };
}

function bindTranscribeButton(postEl, p) {
  const btn = postEl.querySelector(':scope > .post-actions .transcribe-btn');
  if (!btn) return;
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'transcribiendo…';
    try {
      const res = await fetch(`/api/posts/${p.id}/transcribe`, {
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
      // Actualiza la galería del post in-place: añade el transcript bajo el
      // <audio> y refresca data-media para que un swap futuro lo conserve.
      const gallery = postEl.querySelector(':scope > .post-body .gallery');
      updateGalleryTranscript(gallery, data.transcript);
      // El botón se cae para siempre — ya no hay audios sin transcript.
      btn.remove();
    } catch (err) {
      console.error('transcribe failed', err);
      toast('error al transcribir', 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
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
      ${renderPostGallery(p.media)}
      ${renderPostFoot(p)}
    </div>
    ${renderPostActions(p, single)}
  `;
  if (!single) bindPostClickToNavigate(el, p);
  bindViewTwoittButton(el, p);
  bindReplyButton(el, p);
  bindTranscribeButton(el, p);
  bindHideButton(el, p, single);
  bindDeleteButton(el, p, single);
  return el;
}

// Recursivo: renderiza un post + sus replies anidados.
// Si el post raíz está oculto en localStorage, devolvemos null para que
// el caller omita el thread entero (no renderiza ni los descendientes).
// Si un descendiente está oculto, se salta SÓLO ese subtree.
//
// Orden DOM final: body → post-actions → thread-replies. Así la barra de
// acciones queda visualmente "pegada" al cuerpo del post al que pertenece
// (cuando el usuario lo activa), no al fondo del subtree — antes se movía
// al final y daba la sensación de que los botones eran del último hijo.
// Para mantener este invariante, .thread-replies debe insertarse SIEMPRE
// después de .post-actions (usamos actions.after(nested) en vez de appendChild,
// que pondría el nested al final tras la barra).
export function renderThread(p) {
  if (isHidden(p.id)) return null;
  const el = renderPost(p);
  if (p.replies && p.replies.length) {
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    let appended = 0;
    for (const child of p.replies) {
      const childEl = renderThread(child);
      if (childEl) { nested.appendChild(childEl); appended++; }
    }
    if (appended > 0) {
      const actions = el.querySelector(':scope > .post-actions');
      if (actions) actions.after(nested);
      else el.appendChild(nested);
    }
  }
  return el;
}
