// ----- carga de timeline + post single + setup de composers persistentes -----

import { $, toast } from './utils.js';
import { POST_ID } from './state.js';
import { renderThread, renderPost } from './render.js';
import { wireComposer } from './composer.js';
import { notifyThreadChanged } from './rails.js';

// estado de paginación de la timeline. local al módulo porque solo
// loadTimeline lo lee y muta.
let nextCursor = null;
let loading = false;

export async function loadTimeline(reset = false) {
  if (loading) return;
  loading = true;
  try {
    const params = new URLSearchParams();
    const tag = new URLSearchParams(location.search).get('tag');
    const q = new URLSearchParams(location.search).get('q');
    if (tag) params.set('tag', tag);
    if (q) params.set('q', q);
    if (!reset && nextCursor) params.set('cursor', nextCursor);

    const res = await fetch('/api/posts?' + params);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json().catch(() => ({}));
    // Defensa: si el server devuelve algo sin posts (5xx con JSON de error,
    // body vacío, etc.) no queremos romper el feed. Tratamos como "sin más".
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const timeline = $('#timeline');
    if (reset) timeline.innerHTML = '';
    for (const p of posts) {
      const threadEl = renderThread(p);
      if (!threadEl) continue; // post root oculto en localStorage
      const wrap = document.createElement('div');
      wrap.className = 'thread';
      wrap.appendChild(threadEl);
      timeline.appendChild(wrap);
    }
    nextCursor = data?.nextCursor ?? null;
    $('#loadMore').hidden = !nextCursor;
  } catch (err) {
    console.error('loadTimeline failed', err);
    toast('error al cargar timeline', 'error');
  } finally {
    loading = false;
  }
}

export function setupTimelineComposer() {
  wireComposer({
    form: $('#composer'),
    text: $('#text'),
    preview: $('#mediaPreview'),
    fileInput: $('#fileInput'),
    recordBtn: $('#btnRecord'),
    parentId: null,
    onPosted: (post) => {
      const el = renderThread(post);
      if (!el) return; // post oculto (no debería pasar para uno recién creado)
      const wrap = document.createElement('div');
      wrap.className = 'thread';
      wrap.appendChild(el);
      $('#timeline').prepend(wrap);
      notifyThreadChanged({ threadRoot: wrap });
    },
  });
  const lm = $('#loadMore');
  if (lm) lm.addEventListener('click', () => loadTimeline(false));
}

export async function loadSinglePost() {
  let res;
  try {
    res = await fetch(`/api/posts/${POST_ID}`);
  } catch (err) {
    console.error('loadSinglePost network', err);
    $('#postContainer').innerHTML = '<p class="not-found">error de red al cargar el post</p>';
    toast('error de red', 'error');
    return;
  }
  if (!res.ok) {
    $('#postContainer').innerHTML = '<p class="not-found">post no encontrado</p>';
    return;
  }
  const { post, replies } = await res.json();
  document.title = `twoitter — ${post.text?.slice(0, 40) || 'post'}`;
  $('#postContainer').appendChild(renderPost(post, { single: true }));

  if (replies.length) {
    const container = $('#replies');
    let appended = 0;
    for (const r of replies) {
      const el = renderThread(r);
      if (el) { container.appendChild(el); appended++; }
    }
    if (appended > 0) {
      $('#repliesHeader').hidden = false;
    }
  }
}

export function setupReplyForm() {
  wireComposer({
    form: $('#replyForm'),
    text: $('#replyText'),
    preview: $('#replyMediaPreview'),
    fileInput: $('#replyFileInput'),
    recordBtn: $('#replyRecord'),
    parentId: POST_ID,
    onPosted: (reply) => {
      const el = renderThread(reply);
      if (!el) return; // oculto (defensivo)
      $('#repliesHeader').hidden = false;
      $('#replies').appendChild(el);
      notifyThreadChanged({
        parentPost: document.querySelector('#postContainer > .post'),
        threadRoot: $('#replies'),
        delta: +1,
      });
    },
  });
}
