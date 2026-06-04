// ----- carga de timeline + setup de composers persistentes -----

import { $, toast } from './utils.js';
import { api } from './api.js';
import { renderThread, focusPostFromHash } from './render.js';
import { wireComposer } from './composer.js';
import { notifyThreadChanged } from './rails.js';

// estado de paginación de la timeline. local al módulo porque solo
// loadTimeline lo lee y muta.
let nextCursor = null;
let loading = false;
let sentinelObserver = null;
let firstPaintDone = false;

// Render por chunks con requestAnimationFrame: si la respuesta trae 500
// posts, pintarlos en un solo for bloquea el primer paint cerca de 1s en
// móvil. Repartimos en chunks de 30 por frame: el usuario ve los primeros
// inmediatamente y el browser respira entre tandas. La promesa resuelve
// cuando todo está pintado.
const CHUNK_SIZE = 30;
function renderInChunks(posts, parent) {
  return new Promise((resolve) => {
    if (posts.length === 0) { resolve(); return; }
    let i = 0;
    const tick = () => {
      const end = Math.min(posts.length, i + CHUNK_SIZE);
      for (; i < end; i++) {
        const threadEl = renderThread(posts[i]);
        if (!threadEl) continue; // post root oculto en localStorage
        const wrap = document.createElement('div');
        wrap.className = 'thread';
        wrap.appendChild(threadEl);
        parent.appendChild(wrap);
      }
      if (i < posts.length) requestAnimationFrame(tick);
      else resolve();
    };
    tick();
  });
}

// IntersectionObserver sobre un sentinel al final del feed: cuando entra en
// viewport (con margen anticipado para no esperar a ver "el vacío"), si hay
// más posts (nextCursor != null) disparamos otro loadTimeline. Mantiene la
// sensación de "todo cargado" sin meter 10k posts del tirón.
function setupSentinelObserver() {
  if (sentinelObserver) return;
  if (typeof IntersectionObserver === 'undefined') return; // viejo: queda #loadMore
  let sentinel = document.getElementById('tl-sentinel');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.id = 'tl-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    const lm = $('#loadMore');
    lm.parentNode.insertBefore(sentinel, lm);
  }
  sentinelObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && nextCursor && !loading) {
        loadTimeline(false);
      }
    }
  }, { rootMargin: '600px' });
  sentinelObserver.observe(sentinel);
}

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

    const { ok, status, data } = await api('/api/posts?' + params);
    if (!ok) throw new Error(`status ${status}`);
    // Defensa: si el server devuelve algo sin posts (5xx con JSON de error,
    // body vacío, etc.) no queremos romper el feed. Tratamos como "sin más".
    const posts = Array.isArray(data?.posts) ? data.posts : [];
    const timeline = $('#timeline');
    if (reset) timeline.innerHTML = '';
    await renderInChunks(posts, timeline);
    nextCursor = data?.nextCursor ?? null;
    $('#loadMore').hidden = !nextCursor;
    if (reset) {
      setupSentinelObserver();
      // Si la URL trae /#42 al cargar, posicionar la TL en ese post sin
      // animación (ya está donde debe). Solo la primera vez; en cargas
      // posteriores el hash ya quedó procesado.
      if (!firstPaintDone) {
        firstPaintDone = true;
        if (location.hash) focusPostFromHash('instant');
      }
    }
  } catch (err) {
    console.error('loadTimeline failed', err);
    // Si era la carga inicial, limpiar los skeletons estáticos (en loadMore
    // no tocamos lo ya pintado).
    if (reset) $('#timeline').innerHTML = '';
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
    pollEl: $('#composerPoll'),
    pollBtn: $('#btnPoll'),
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
