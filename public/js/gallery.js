// ----- galería modular: stage + thumbs + lightbox -----
//
// Sustituye al grid count-N anterior. La galería es la misma sea imagen,
// vídeo o mezcla: stage arriba (item actual) + thumbs centradas si N>1.
// Click en thumb → swap del stage. Click en imagen del stage → lightbox.
// Los vídeos van SIEMPRE con controls + play manual, jamás autoplay.
//
// El swap es asíncrono: precarga la imagen, hace fade-out, swapea, fade-in.
// Un contador por galería actúa como race-guard para que clicks rápidos no
// pinten frames de medios intermedios.
//
// Todo el wiring vive en setupGallery() y usa delegación global desde
// document → sobrevive a re-renders del feed sin tener que rebindear.

import { escapeHtml } from './utils.js';
import { audioPlayerMarkup } from './audio-player.js';

// Duración de cada fase (fade-out y fade-in/altura). Debe coincidir con
// la CSS: .gallery > .stage / .lightbox-stage  transition: ... Xms ...
// 240ms con cubic-bezier(0.4, 0, 0.2, 1) — suave sin sentirse lento.
// Si el usuario tiene prefers-reduced-motion, saltamos toda la animación
// para no quedarnos 240ms con el stage en blanco (la CSS también respeta
// el flag y deja la transición instantánea).
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = REDUCED_MOTION ? 0 : 240;

// ----- templates (sin side effects) -----

// Defensa en profundidad: r2_key viene de BD pero se interpola en atributos
// HTML. Si alguna vez se cuela un valor con comillas (manual, migración,
// export-import), escaparlo evita inyección de atributos / XSS.
function mediaItemHtml(m) {
  const src = escapeHtml(m.r2_key);
  if (m.kind === 'image') {
    return `<img src="/r2/${src}" alt="">`;
  }
  if (m.kind === 'audio') {
    // Markup + lógica del player viven en audio-player.js. Aquí solo
    // delegamos; cambiar la apariencia del player o el ARIA se hace allí.
    return audioPlayerMarkup({ r2_key: m.r2_key, transcript: m.transcript });
  }
  const poster = m.thumb_key ? ` poster="/r2/${escapeHtml(m.thumb_key)}"` : '';
  return `<video src="/r2/${src}" controls preload="metadata"${poster} playsinline></video>`;
}

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

function readMedia(galleryEl) {
  try {
    const arr = JSON.parse(galleryEl.dataset.media || '[]');
    return arr.map((m) => ({ kind: m.k, r2_key: m.r, thumb_key: m.t, transcript: m.tr || null }));
  } catch { return []; }
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

// ----- preload + helpers -----

// Decodifica la imagen en caché antes de insertarla en el DOM. Así, cuando
// el <img> aparezca, sus píxeles ya están listos y no hay flash de placeholder
// ni de la imagen vecina. Si el navegador no soporta decode(), cae a un
// onload/onerror con timeout de seguridad para no bloquear los tests.
function preloadImage(url) {
  if (typeof Image === 'undefined') return Promise.resolve();
  const pre = new Image();
  pre.src = url;
  if (typeof pre.decode === 'function') {
    return pre.decode().catch(() => {});
  }
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    pre.onload = finish;
    pre.onerror = finish;
    setTimeout(finish, 2000);
  });
}

function nextFrame() {
  return new Promise((res) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => res());
    else setTimeout(res, 16);
  });
}

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// Mide la altura natural del contenido del stage SIN su transición visible
// (la opacity ya está a 0 durante el swap). Quita el lock de altura, fuerza
// reflow y captura la nueva altura. Devuelve la medición; el caller decide
// cómo aplicarla.
function measureNaturalHeight(stage) {
  const prev = stage.style.height;
  stage.style.height = '';
  // forzar reflow tocando offsetHeight (lee → flush)
  void stage.offsetHeight;
  const h = stage.getBoundingClientRect().height;
  stage.style.height = prev;
  return h;
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

  // Snapshot de altura ACTUAL para anclar el FLIP de height: from → to.
  // getBoundingClientRect funciona en feed (offsetHeight serviría también
  // pero queremos el rect real con sub-pixel).
  const fromH = stage.getBoundingClientRect().height;

  // Fade-out + preload en paralelo. Si el preload va más rápido que el fade,
  // esperamos al fade; si va más lento, esperamos al preload.
  // Lockeamos la altura a fromH durante la fase de fade-out: así, aunque
  // el contenido nuevo entre en el DOM con otra altura, no hay saltos.
  stage.style.height = `${fromH}px`;
  stage.classList.add('is-fading');
  const preloadP = m.kind === 'image' ? preloadImage(`/r2/${m.r2_key}`) : Promise.resolve();
  await Promise.all([preloadP, wait(FADE_MS)]);

  // Si llegó otro swap mientras estábamos esperando, dejar que ese pinte.
  if (galleryNav.get(galleryEl) !== myNav) {
    // Importante: no limpiamos el height aquí — el swap que nos superó
    // lo gestionará. Si por algún motivo no lo hace, el setTimeout final
    // de aquel se encargará.
    return;
  }

  // Pausar vídeo previo antes de reemplazar (audio fantasma).
  stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });

  stage.dataset.index = String(index);
  stage.innerHTML = mediaItemHtml(m);

  // Medir altura natural del nuevo contenido, restaurar el lock a fromH
  // (para que la transición arranque de fromH y no salte) y forzar reflow.
  const toH = measureNaturalHeight(stage);
  stage.style.height = `${fromH}px`;
  await nextFrame();

  if (galleryNav.get(galleryEl) !== myNav) return;

  // Disparar a la vez: height fromH → toH y opacity 0 → 1.
  stage.style.height = `${toH}px`;
  stage.classList.remove('is-fading');

  // Limpiar el lock de altura tras la transición para que la galería siga
  // siendo responsive (resize del viewport, video que mueve sus dims, etc).
  setTimeout(() => {
    if (galleryNav.get(galleryEl) === myNav) {
      stage.style.height = '';
    }
  }, FADE_MS + 80);
}

// ----- lightbox (singleton, lazy) -----

let lightboxEl = null;
let lightboxState = { media: [], index: 0 };
let lbNav = 0;
// Foco previo: elemento que tenía el foco cuando se abrió el lightbox.
// Al cerrar, devolvemos el foco ahí (típicamente la thumb/imagen clicada),
// que es el contrato a11y esperado de un dialog modal.
let lightboxPrevFocus = null;

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

// Sincrónico: contador + flechas. La parte visual (preload + swap) se hace
// async dentro de renderLightbox; los tests que comprueban contador/flechas
// pueden hacerlo sin awaits.
function syncLightboxChrome(lb) {
  const { media, index } = lightboxState;
  lb.querySelector('.lightbox-counter').textContent =
    media.length > 1 ? `${index + 1} / ${media.length}` : '';
  const single = media.length <= 1;
  lb.querySelector('.lightbox-prev').hidden = single;
  lb.querySelector('.lightbox-next').hidden = single;
}

async function renderLightbox({ animate = true } = {}) {
  const myNav = ++lbNav;
  const lb = ensureLightbox();
  const { media, index } = lightboxState;
  if (!media[index]) return;
  const m = media[index];
  const stage = lb.querySelector('.lightbox-stage');

  syncLightboxChrome(lb);

  // Snapshot de altura (sólo si vamos a animar; en el primer open no hay
  // nada que medir todavía y la altura natural será la final).
  const fromH = animate ? stage.getBoundingClientRect().height : 0;

  if (animate) {
    stage.style.height = `${fromH}px`;
    stage.classList.add('is-fading');
  }
  const preloadP = m.kind === 'image' ? preloadImage(`/r2/${m.r2_key}`) : Promise.resolve();
  await Promise.all([preloadP, animate ? wait(FADE_MS) : Promise.resolve()]);

  if (myNav !== lbNav) return; // superado por una navegación posterior

  stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
  stage.innerHTML = mediaItemHtml(m);

  if (animate) {
    const toH = measureNaturalHeight(stage);
    stage.style.height = `${fromH}px`;
    await nextFrame();
    if (myNav !== lbNav) return;
    stage.style.height = `${toH}px`;
    stage.classList.remove('is-fading');
    setTimeout(() => {
      if (myNav === lbNav) stage.style.height = '';
    }, FADE_MS + 80);
  }
}

export async function openLightbox(media, index = 0) {
  if (!media || media.length === 0) return;
  lightboxState = { media: media.slice(), index };
  // Guardar elemento focado para devolverle el foco al cerrar.
  lightboxPrevFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement : null;
  const lb = ensureLightbox();
  // Mostrar shell + sincronizar UI antes del preload para feedback inmediato.
  syncLightboxChrome(lb);
  lb.hidden = false;
  document.body.classList.add('lightbox-open');
  // Mover foco al botón de cerrar — punto de entrada al modal.
  try { lb.querySelector('.lightbox-close').focus(); } catch {}
  // primera carga: sin fade-out (no hay nada que ocultar), sólo preload.
  await renderLightbox({ animate: false });
}

export function closeLightbox() {
  if (!lightboxEl) return;
  // Bumpea el nav: si hay un render en vuelo, se descartará antes de pintar.
  ++lbNav;
  lightboxEl.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
  const stage = lightboxEl.querySelector('.lightbox-stage');
  stage.innerHTML = '';
  stage.classList.remove('is-fading');
  stage.style.height = '';
  lightboxEl.hidden = true;
  document.body.classList.remove('lightbox-open');
  // Devolver el foco al elemento que lo tenía antes de abrir (típicamente
  // la thumb o la imagen del stage). Si ya no está en el DOM, fallback al body.
  if (lightboxPrevFocus && lightboxPrevFocus.isConnected) {
    try { lightboxPrevFocus.focus(); } catch {}
  }
  lightboxPrevFocus = null;
}

function lightboxNav(delta) {
  const { media, index } = lightboxState;
  if (media.length <= 1) return;
  lightboxState.index = (index + delta + media.length) % media.length;
  // fire-and-forget — race-guard interno se encarga del orden.
  renderLightbox();
}

// Construye la lista para el lightbox: filtra audios (el lightbox es para
// medios visuales — el audio se escucha mejor inline en el feed). Mapea el
// índice del stage al índice equivalente dentro de la lista filtrada.
//
// Estaba en el closure del click handler, pero se aisla aquí para que tests
// y futuros callers (p.ej. abrir lightbox desde teclado) puedan reusar.
function lightboxMediaFrom(galleryEl, stageIndex) {
  const all = readMedia(galleryEl);
  const visual = all.filter((m) => m.kind !== 'audio');
  let mappedIndex = 0;
  for (let i = 0; i < stageIndex && i < all.length; i++) {
    if (all[i].kind !== 'audio') mappedIndex++;
  }
  // Si el stage estaba en un audio (caso imposible vía click — no hay <img>),
  // ajusta dentro de rango para defensa.
  if (mappedIndex >= visual.length) mappedIndex = Math.max(0, visual.length - 1);
  return { visual, mappedIndex };
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
    else if (e.key === 'Tab') trapTab(e);
  });

  // Focus trap: lista los focusables del lightbox y hace ciclo dentro de
  // ellos al tabular (Shift+Tab al revés). Sin esto, Tab se va a elementos
  // de detrás del overlay y rompe la promesa de aria-modal=true.
  function trapTab(e) {
    const focusables = lightboxEl.querySelectorAll(
      'button:not([hidden]):not([disabled]), [href], video[controls], [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    } else if (!lightboxEl.contains(active)) {
      // Foco se escapó por algún motivo — devolver al primero.
      e.preventDefault();
      first.focus();
    }
  }

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
