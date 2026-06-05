// ----- carga de timeline + setup de composers persistentes -----

import { $, toast, nextFrame } from './utils.js';
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

// ----- scroll-spy: la URL /#id sigue al post que estás viendo -----
//
// Inverso del deep-link (clic en #id → scroll): conforme scrolleas, la barra de
// direcciones se actualiza a /#id del post centrado en el viewport, vía
// history.replaceState (NO location.hash, que dispararía el hashchange → un
// scroll). Así recargar o compartir te devuelve a donde estabas. Patrón
// scrollspy (como el de la web de mirandaperezhita), adaptado a un feed.
//
// Implementado con un listener de scroll (no IntersectionObserver): elegimos el
// ítem del carrete cuyo borde superior ha cruzado la línea de activación (40%
// del viewport). Como solo corre AL scrollear, la home arranca con la URL limpia.
let spyActiveId = null;
let spyLastTs = 0;

// Ítem "activo" del carrete: el ÚLTIMO cuyo borde superior ha cruzado la línea
// de activación (40% del viewport desde arriba). Patrón scrollspy: conforme
// scrolleas, el activo avanza SIN huecos — a diferencia de "el que cruza el
// centro exacto", que fallaba cuando el centro caía en el margen entre dos
// threads. Los posts van en orden vertical en el DOM, así que en cuanto uno
// queda por debajo de la línea, los siguientes también → cortamos el bucle.
function activeCarouselPost() {
  const line = innerHeight * 0.4;
  let active = null;
  for (const p of document.querySelectorAll('#timeline > .thread > .post')) {
    if (p.getBoundingClientRect().top <= line) active = p;
    else break;
  }
  return active;
}

function updateSpyHash() {
  const p = activeCarouselPost();
  if (!p) return;
  const id = p.dataset.id;
  if (!id || id === spyActiveId) return; // sin cambio → no reescribir la URL
  spyActiveId = id;
  // replaceState (no location.hash=): actualiza la barra de direcciones sin
  // disparar el hashchange ni acumular entradas en el historial.
  history.replaceState(history.state, '', '#' + id);
}

function setupScrollSpy() {
  if (setupScrollSpy._wired) return; // idempotente: un solo listener
  setupScrollSpy._wired = true;
  // Throttle por timestamp (no rAF): ligero y no depende del bucle de paint
  // — robusto también donde rAF no corre. ~10 cálculos/s sobran para el hash.
  addEventListener('scroll', () => {
    const now = Date.now();
    if (now - spyLastTs < 100) return;
    spyLastTs = now;
    updateSpyHash();
  }, { passive: true });
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
    if (reset) {
      timeline.innerHTML = '';
      spyActiveId = null; // el feed cambió; se recalcula al primer scroll
    }
    await renderInChunks(posts, timeline);
    nextCursor = data?.nextCursor ?? null;
    $('#loadMore').hidden = !nextCursor;
    setupScrollSpy(); // idempotente: cablea el listener de scroll una vez
    if (reset) {
      setupSentinelObserver();
      // Si la URL trae /#42 al cargar, posicionar la TL en ese post. Solo la
      // primera vez; en cargas posteriores el hash ya quedó procesado.
      if (!firstPaintDone) {
        firstPaintDone = true;
        if (location.hash) loadUntilHashPost('instant');
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

// Deep-link a una posición del carrete: si el post del hash aún no está en el
// DOM (cae en una página posterior), seguimos auto-cargando hasta que aparezca
// o se agote la TL, y entonces lo centramos. Así un /#id a un post antiguo
// posiciona el carrete cargando las páginas intermedias.
//   - Post ya cargado (caso común) → el while no entra, centra al instante.
//   - Si hubo que cargar páginas → 'instant' (un scroll suave a través de
//     miles de px recién insertados sería absurdo).
//   - Cap de 60 páginas por si el id no existe (link roto): evita bucle.
async function loadUntilHashPost(preferred = 'smooth') {
  const id = location.hash.replace(/^#/, '');
  if (!id) return;
  const sel = `article.post[data-id="${CSS.escape(id)}"]`;
  let loadedPages = 0;
  while (!document.querySelector(sel) && nextCursor && loadedPages < 60) {
    await loadTimeline(false);
    loadedPages++;
  }
  if (loadedPages > 0) {
    // Cargamos páginas: el render por chunks puede no haber asentado el layout
    // en este tick. Doble frame para medir con el layout ya flusheado.
    await nextFrame();
    await nextFrame();
    focusPostFromHash('instant');
  } else {
    // Caso común (hashchange in-app: el post ya está en el DOM): centramos YA,
    // sin rAF — directo y fiable (no dependemos del loop de pintado).
    focusPostFromHash(preferred);
  }
}

// Click en un permalink / "en respuesta a" / "ver twoitt", o edición manual
// de la URL → cargar hasta el post y centrarlo. Lo gobierna pages.js (no
// render.js) porque aquí está el acceso a la paginación (loadTimeline).
window.addEventListener('hashchange', () => loadUntilHashPost('smooth'));

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
