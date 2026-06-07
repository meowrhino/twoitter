// ----- galería del feed: stage + thumbs -----
//
// La galería es la misma sea imagen, vídeo o mezcla: stage arriba (item actual)
// + thumbs centradas si N>1. Click en thumb → swap del stage. Click en imagen
// del stage → lightbox (visor modal, en lightbox.js). Los vídeos van SIEMPRE con
// controls + play manual, jamás autoplay.
//
// Las primitivas compartidas con el lightbox (mediaItemHtml, readMedia,
// preloadImage, crossfadeSwap) viven en gallery-core.js. El visor modal y su
// wiring viven en lightbox.js. Aquí queda lo propio del feed.
//
// El swap es asíncrono: precarga la imagen, hace fade-out, swapea, fade-in.
// Un contador por galería actúa como race-guard para que clicks rápidos no
// pinten frames de medios intermedios. Todo el wiring vive en setupGallery() y
// usa delegación global desde document → sobrevive a re-renders del feed.

import { escapeHtml } from './utils.js';
import { mediaItemHtml, readMedia, preloadImage, crossfadeSwap } from './gallery-core.js';
import { openLightbox, lightboxMediaFrom, setupLightbox } from './lightbox.js';

// ----- templates (sin side effects) -----

function thumbHtml(m, index, active) {
  const cls = `thumb${active ? ' is-active' : ''}`;
  const sel = active ? 'true' : 'false';
  const src = escapeHtml(m.r2_key);
  if (m.kind === 'image') {
    return `<button class="${cls}" type="button" role="tab" aria-selected="${sel}" data-index="${index}" aria-label="ver imagen ${index + 1}">
      <img src="/r2/${src}" alt="" loading="lazy">
    </button>`;
  }
  if (m.kind === 'audio') {
    return `<button class="${cls} thumb-audio" type="button" role="tab" aria-selected="${sel}" data-index="${index}" aria-label="oír nota de voz ${index + 1}">
      <span class="audio-glyph" aria-hidden="true">🎙️</span>
    </button>`;
  }
  const inner = m.thumb_key
    ? `<img src="/r2/${escapeHtml(m.thumb_key)}" alt="" loading="lazy">`
    : `<span class="thumb-placeholder" aria-hidden="true"></span>`;
  return `<button class="${cls}" type="button" role="tab" aria-selected="${sel}" data-index="${index}" aria-label="ver vídeo ${index + 1}">
    ${inner}
    <span class="play-badge" aria-hidden="true">▶</span>
  </button>`;
}

// Punto de entrada usado por render.js. Devuelve el HTML completo de la
// galería. data-media lleva la lista entera (en JSON corto) para que el
// swap del stage y el lightbox no tengan que reconstruirla. Para audio,
// llevamos también el transcript ya cacheado (o null si aún no se llamó
// a /transcribe).
export function renderPostGallery(media) {
  if (!media || media.length === 0) return '';
  const payload = media.map((m) => ({
    k: m.kind,
    r: m.r2_key,
    t: m.thumb_key || null,
    tr: m.kind === 'audio' ? (m.transcript || null) : null,
  }));
  const dataAttr = escapeHtml(JSON.stringify(payload));
  const stage = `<div class="stage" data-index="0">${mediaItemHtml(media[0])}</div>`;
  const thumbs = media.length > 1
    ? `<div class="thumbs" role="tablist">${media.map((m, i) => thumbHtml(m, i, i === 0)).join('')}</div>`
    : '';
  return `<div class="gallery" data-count="${media.length}" data-media="${dataAttr}">${stage}${thumbs}</div>`;
}

// Tras transcribir, refresca el data-media de la galería para que el
// próximo swap muestre el transcript ya cacheado y para que el botón
// "transcribir" sepa que ya está hecho. Se llama desde render.js.
export function updateGalleryTranscript(galleryEl, transcript) {
  if (!galleryEl) return;
  const arr = readMedia(galleryEl);
  let changed = false;
  for (const m of arr) {
    if (m.kind === 'audio' && !m.transcript) {
      m.transcript = transcript;
      changed = true;
    }
  }
  if (!changed) return;
  const payload = arr.map((m) => ({
    k: m.kind, r: m.r2_key, t: m.thumb_key || null,
    tr: m.kind === 'audio' ? (m.transcript || null) : null,
  }));
  galleryEl.dataset.media = JSON.stringify(payload);
  // Si el stage está mostrando un audio, inyectar/actualizar el bloque del
  // transcript sin re-renderizar el <audio> entero (evita parar el playback).
  const stage = galleryEl.querySelector(':scope > .stage');
  const audio = stage?.querySelector('audio');
  if (audio) {
    let block = stage.querySelector('.audio-transcript');
    if (!block) {
      block = document.createElement('div');
      block.className = 'audio-transcript';
      stage.appendChild(block);
    }
    block.textContent = transcript;
    block.dataset.transcript = '1';
    block.hidden = false;
  }
}

// ----- swap del stage (con preload + fade) -----

// Por galería, un contador monotónico: cada llamada coge el suyo; cuando
// vaya a pintar, si ya hay uno más nuevo en vuelo, abandona. Así clicks
// rápidos sólo muestran el último frame, sin parpadeos intermedios.
const galleryNav = new WeakMap();

export async function swapStage(galleryEl, index) {
  const media = readMedia(galleryEl);
  if (index < 0 || index >= media.length) return;
  const stage = galleryEl.querySelector(':scope > .stage');
  if (!stage) return;

  const myNav = (galleryNav.get(galleryEl) || 0) + 1;
  galleryNav.set(galleryEl, myNav);

  // Feedback inmediato en las thumbs (no esperar al fade).
  galleryEl.querySelectorAll(':scope > .thumbs > .thumb').forEach((b, i) => {
    const active = i === index;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const m = media[index];
  await crossfadeSwap(stage, {
    preload: m.kind === 'image' ? preloadImage(`/r2/${m.r2_key}`) : null,
    isCurrent: () => galleryNav.get(galleryEl) === myNav,
    paint: () => {
      stage.dataset.index = String(index);
      stage.innerHTML = mediaItemHtml(m);
    },
  });
}

// ----- wiring global (idempotente) -----

let wired = false;
export function setupGallery() {
  if (wired) return;
  wired = true;

  // El visor modal cablea sus propios controles/teclado/swipe.
  setupLightbox();

  document.addEventListener('click', (e) => {
    // thumb → cambiar de stage
    const thumb = e.target.closest('.gallery > .thumbs > .thumb');
    if (thumb) {
      e.stopPropagation();
      const gallery = thumb.closest('.gallery');
      swapStage(gallery, parseInt(thumb.dataset.index, 10));
      return;
    }
    // imagen del stage → abrir lightbox (el vídeo conserva sus controls;
    // los audios nunca abren lightbox — no hay <img> que clickar).
    const stageImg = e.target.closest('.gallery > .stage > img');
    if (stageImg) {
      e.stopPropagation();
      const stage = stageImg.parentElement;
      const gallery = stage.closest('.gallery');
      const stageIndex = parseInt(stage.dataset.index || '0', 10);
      const { visual, mappedIndex } = lightboxMediaFrom(gallery, stageIndex);
      // Si el post sólo tiene audios (no debería pasar — el handler de stage
      // img garantiza que hay al menos una imagen), no abrir el lightbox.
      if (visual.length > 0) openLightbox(visual, mappedIndex);
    }
  });
}
