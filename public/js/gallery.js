// ----- galería modular: stage + thumbs + lightbox -----
//
// Sustituye al grid count-N anterior. La galería es la misma sea imagen,
// vídeo o mezcla: stage arriba (item actual) + thumbs centradas si N>1.
// Click en thumb → swap del stage. Click en imagen del stage → lightbox.
// Los vídeos van SIEMPRE con controls + play manual, jamás autoplay.
//
// Todo el wiring vive en setupGallery() y usa delegación global desde
// document → sobrevive a re-renders del feed sin tener que rebindear.

import { escapeHtml } from './utils.js';

// ----- templates (sin side effects) -----

function mediaItemHtml(m) {
  if (m.kind === 'image') {
    return `<img src="/r2/${m.r2_key}" alt="" loading="lazy">`;
  }
  const poster = m.thumb_key ? ` poster="/r2/${m.thumb_key}"` : '';
  return `<video src="/r2/${m.r2_key}" controls preload="metadata"${poster} playsinline></video>`;
}

function thumbHtml(m, index, active) {
  const cls = `thumb${active ? ' is-active' : ''}`;
  const sel = active ? 'true' : 'false';
  if (m.kind === 'image') {
    return `<button class="${cls}" type="button" role="tab" aria-selected="${sel}" data-index="${index}" aria-label="ver imagen ${index + 1}">
      <img src="/r2/${m.r2_key}" alt="" loading="lazy">
    </button>`;
  }
  const inner = m.thumb_key
    ? `<img src="/r2/${m.thumb_key}" alt="" loading="lazy">`
    : `<span class="thumb-placeholder" aria-hidden="true"></span>`;
  return `<button class="${cls}" type="button" role="tab" aria-selected="${sel}" data-index="${index}" aria-label="ver vídeo ${index + 1}">
    ${inner}
    <span class="play-badge" aria-hidden="true">▶</span>
  </button>`;
}

// Punto de entrada usado por render.js. Devuelve el HTML completo de la
// galería. data-media lleva la lista entera (en JSON corto) para que el
// swap del stage y el lightbox no tengan que reconstruirla.
export function renderPostGallery(media) {
  if (!media || media.length === 0) return '';
  const payload = media.map((m) => ({ k: m.kind, r: m.r2_key, t: m.thumb_key || null }));
  const dataAttr = escapeHtml(JSON.stringify(payload));
  const stage = `<div class="stage" data-index="0">${mediaItemHtml(media[0])}</div>`;
  const thumbs = media.length > 1
    ? `<div class="thumbs" role="tablist">${media.map((m, i) => thumbHtml(m, i, i === 0)).join('')}</div>`
    : '';
  return `<div class="gallery" data-count="${media.length}" data-media="${dataAttr}">${stage}${thumbs}</div>`;
}

function readMedia(galleryEl) {
  try {
    const arr = JSON.parse(galleryEl.dataset.media || '[]');
    return arr.map((m) => ({ kind: m.k, r2_key: m.r, thumb_key: m.t }));
  } catch { return []; }
}

// Reemplaza el contenido del stage. Exportado para tests.
export function swapStage(galleryEl, index) {
  const media = readMedia(galleryEl);
  if (index < 0 || index >= media.length) return;
  const stage = galleryEl.querySelector(':scope > .stage');
  if (!stage) return;
  stage.dataset.index = String(index);
  stage.innerHTML = mediaItemHtml(media[index]);
  galleryEl.querySelectorAll(':scope > .thumbs > .thumb').forEach((b, i) => {
    const active = i === index;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

// ----- lightbox (singleton, lazy) -----

let lightboxEl = null;
let lightboxState = { media: [], index: 0 };

function ensureLightbox() {
  if (lightboxEl && lightboxEl.isConnected) return lightboxEl;
  if (lightboxEl) { document.body.appendChild(lightboxEl); return lightboxEl; }
  lightboxEl = document.createElement('div');
  lightboxEl.className = 'lightbox';
  lightboxEl.setAttribute('role', 'dialog');
  lightboxEl.setAttribute('aria-modal', 'true');
  lightboxEl.setAttribute('aria-label', 'visor de medios');
  lightboxEl.hidden = true;
  lightboxEl.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="cerrar">×</button>
    <button class="lightbox-prev" type="button" aria-label="anterior">‹</button>
    <button class="lightbox-next" type="button" aria-label="siguiente">›</button>
    <div class="lightbox-stage"></div>
    <div class="lightbox-counter" aria-live="polite"></div>
  `;
  document.body.appendChild(lightboxEl);
  return lightboxEl;
}

function renderLightbox() {
  const lb = ensureLightbox();
  const { media, index } = lightboxState;
  lb.querySelector('.lightbox-stage').innerHTML = mediaItemHtml(media[index]);
  const counter = lb.querySelector('.lightbox-counter');
  counter.textContent = media.length > 1 ? `${index + 1} / ${media.length}` : '';
  const single = media.length <= 1;
  lb.querySelector('.lightbox-prev').hidden = single;
  lb.querySelector('.lightbox-next').hidden = single;
}

export function openLightbox(media, index = 0) {
  if (!media || media.length === 0) return;
  lightboxState = { media: media.slice(), index };
  const lb = ensureLightbox();
  renderLightbox();
  lb.hidden = false;
  document.body.classList.add('lightbox-open');
}

export function closeLightbox() {
  if (!lightboxEl) return;
  // pausar vídeos antes de vaciar para evitar audio fantasma
  lightboxEl.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
  lightboxEl.querySelector('.lightbox-stage').innerHTML = '';
  lightboxEl.hidden = true;
  document.body.classList.remove('lightbox-open');
}

function lightboxNav(delta) {
  const { media, index } = lightboxState;
  if (media.length <= 1) return;
  lightboxState.index = (index + delta + media.length) % media.length;
  renderLightbox();
}

// ----- wiring global (idempotente) -----

let wired = false;
export function setupGallery() {
  if (wired) return;
  wired = true;

  document.addEventListener('click', (e) => {
    // thumb → cambiar de stage
    const thumb = e.target.closest('.gallery > .thumbs > .thumb');
    if (thumb) {
      e.stopPropagation();
      const gallery = thumb.closest('.gallery');
      swapStage(gallery, parseInt(thumb.dataset.index, 10));
      return;
    }
    // imagen del stage → abrir lightbox (el vídeo conserva sus controls)
    const stageImg = e.target.closest('.gallery > .stage > img');
    if (stageImg) {
      e.stopPropagation();
      const stage = stageImg.parentElement;
      const gallery = stage.closest('.gallery');
      openLightbox(readMedia(gallery), parseInt(stage.dataset.index || '0', 10));
      return;
    }
    // controles del lightbox
    if (!lightboxEl || lightboxEl.hidden) return;
    if (e.target.closest('.lightbox-close')) { closeLightbox(); return; }
    if (e.target.closest('.lightbox-prev')) { lightboxNav(-1); return; }
    if (e.target.closest('.lightbox-next')) { lightboxNav(1); return; }
    // click en backdrop (no en el stage ni en botones) → cerrar
    if (e.target === lightboxEl) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (!lightboxEl || lightboxEl.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxNav(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); lightboxNav(1); }
  });

  let touchStartX = null;
  document.addEventListener('touchstart', (e) => {
    if (!lightboxEl || lightboxEl.hidden) return;
    if (!e.target.closest('.lightbox-stage')) return;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 40) return;
    lightboxNav(dx < 0 ? 1 : -1);
  });
}
