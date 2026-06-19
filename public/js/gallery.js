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

import { escapeHtml, toast } from './utils.js';
import { api } from './api.js';
import { isAuthed } from './auth.js';
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

// Contenido del stage para un media. Para audio sin transcript y con sesión
// (sólo el dueño gasta cuota de Whisper) añade un botón "transcribir" propio de
// ESE audio (data-mid = media id). Así un twoitt con varias notas se transcribe
// una a una (cada audio activo en el stage muestra el suyo). El player + el
// bloque .audio-transcript los pone mediaItemHtml/audioPlayerMarkup; aquí sólo
// colgamos el botón detrás. NO se mete en audioPlayerMarkup porque ese markup
// lo comparten el composer (audio aún sin guardar) y el lightbox.
function stageItemHtml(m) {
  const base = mediaItemHtml(m);
  if (m.kind === 'audio' && !m.transcript && isAuthed() && m.id != null) {
    return `${base}<button class="audio-transcribe-btn" type="button" data-mid="${m.id}">transcribir</button>`;
  }
  return base;
}

// Punto de entrada usado por render.js. Devuelve el HTML completo de la
// galería. data-media lleva la lista entera (en JSON corto) para que el
// swap del stage y el lightbox no tengan que reconstruirla. Para audio,
// llevamos también el id (para transcribir el audio concreto) y el transcript
// ya cacheado (o null si aún no se llamó a /transcribe).
export function renderPostGallery(media) {
  if (!media || media.length === 0) return '';
  const payload = media.map((m) => ({
    k: m.kind,
    r: m.r2_key,
    t: m.thumb_key || null,
    id: m.id ?? null,
    tr: m.kind === 'audio' ? (m.transcript || null) : null,
  }));
  const dataAttr = escapeHtml(JSON.stringify(payload));
  const stage = `<div class="stage" data-index="0">${stageItemHtml(media[0])}</div>`;
  const thumbs = media.length > 1
    ? `<div class="thumbs" role="tablist">${media.map((m, i) => thumbHtml(m, i, i === 0)).join('')}</div>`
    : '';
  return `<div class="gallery" data-count="${media.length}" data-media="${dataAttr}">${stage}${thumbs}</div>`;
}

// Tras transcribir UN audio (mediaId), refresca el data-media de la galería —
// sólo la entrada de ese audio — para que el próximo swap muestre su transcript
// ya cacheado y no vuelva a ofrecer el botón. Si ese audio es además el que está
// en el stage ahora mismo, inyecta su bloque de transcript en sitio (sin recrear
// el <audio>, para no cortar el playback).
export function updateGalleryTranscript(galleryEl, mediaId, transcript) {
  if (!galleryEl) return;
  const idNum = Number(mediaId);
  const arr = readMedia(galleryEl);
  let changed = false;
  for (const m of arr) {
    if (m.kind === 'audio' && m.id === idNum && !m.transcript) {
      m.transcript = transcript;
      changed = true;
    }
  }
  if (!changed) return;
  galleryEl.dataset.media = JSON.stringify(arr.map((m) => ({
    k: m.kind, r: m.r2_key, t: m.thumb_key || null, id: m.id ?? null,
    tr: m.kind === 'audio' ? (m.transcript || null) : null,
  })));
  // ¿El stage muestra justo este audio? (la transcripción se dispara desde su
  // propio botón, así que casi siempre sí). Rellenar su bloque in situ.
  const stage = galleryEl.querySelector(':scope > .stage');
  const stageIdx = Number(stage?.dataset.index || 0);
  if (stage?.querySelector('audio') && arr[stageIdx]?.id === idNum) {
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
      stage.innerHTML = stageItemHtml(m);
    },
  });
}

// Pide a Whisper la transcripción de UN audio (por media id) y la pinta bajo su
// player. Idempotente en backend (si ya estaba, devuelve la cacheada). El botón
// es por-audio, así que en un twoitt con varias notas cada una se transcribe y
// guarda por separado.
async function transcribeAudio(btn) {
  if (btn.disabled) return;
  const mid = btn.dataset.mid;
  if (!mid) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'transcribiendo…';
  const { ok, data } = await api(`/api/media/${mid}/transcribe`, { method: 'POST' });
  if (!ok || !data?.transcript) {
    toast(data?.error || 'error al transcribir', 'error');
    btn.disabled = false;
    btn.textContent = original;
    return;
  }
  const gallery = btn.closest('.gallery');
  updateGalleryTranscript(gallery, mid, data.transcript);
  btn.remove(); // ya transcrito: fuera el botón (el bloque de texto ya se ve)
}

// ----- wiring global (idempotente) -----

let wired = false;
export function setupGallery() {
  if (wired) return;
  wired = true;

  // El visor modal cablea sus propios controles/teclado/swipe.
  setupLightbox();

  document.addEventListener('click', (e) => {
    // botón "transcribir" de un audio del stage → transcribe ESA nota
    const trBtn = e.target.closest('.gallery .audio-transcribe-btn');
    if (trBtn) {
      e.stopPropagation();
      transcribeAudio(trBtn);
      return;
    }
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
