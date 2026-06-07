// ----- lightbox (visor modal de medios, singleton lazy) -----
//
// Extraído de gallery.js. Abre un medio visual a pantalla completa con
// navegación (flechas/teclado/swipe) y crossfade. Importa las primitivas de
// gallery-core.js (no de gallery.js) para no crear un ciclo. El que abre el
// lightbox es la galería del feed (gallery.js llama a openLightbox); aquí solo
// vive el visor en sí y su wiring (setupLightbox).

import { mediaItemHtml, readMedia, preloadImage, crossfadeSwap } from './gallery-core.js';
import { ensureModal, trapTab } from './modal.js';

let lightboxEl = null;
let lightboxState = { media: [], index: 0 };
let lbNav = 0;
// Foco previo: elemento que tenía el foco cuando se abrió el lightbox.
// Al cerrar, devolvemos el foco ahí (típicamente la thumb/imagen clicada),
// que es el contrato a11y esperado de un dialog modal.
let lightboxPrevFocus = null;

function ensureLightbox() {
  lightboxEl = ensureModal(lightboxEl, {
    className: 'lightbox',
    label: 'visor de medios',
    html: `
    <button class="lightbox-close" type="button" aria-label="cerrar">×</button>
    <button class="lightbox-prev" type="button" aria-label="anterior">‹</button>
    <button class="lightbox-next" type="button" aria-label="siguiente">›</button>
    <div class="lightbox-stage"></div>
    <div class="lightbox-counter" aria-live="polite"></div>
  `,
  });
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

  const preload = m.kind === 'image' ? preloadImage(`/r2/${m.r2_key}`) : null;
  const isCurrent = () => myNav === lbNav;
  const paint = () => { stage.innerHTML = mediaItemHtml(m); };

  // Primer open (animate:false): no hay nada que ocultar → sin fade-out ni FLIP,
  // solo preload + pintar. El resto de navegaciones van por el crossfade.
  if (!animate) {
    await (preload || Promise.resolve());
    if (!isCurrent()) return; // superado por una navegación/cierre posterior
    stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
    paint();
    return;
  }
  await crossfadeSwap(stage, { preload, paint, isCurrent });
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

// Construye la lista para el lightbox a partir de una galería del feed: filtra
// audios (el lightbox es para medios visuales — el audio se escucha mejor inline
// en el feed). Mapea el índice del stage al índice equivalente dentro de la
// lista filtrada. Lo usa gallery.js al clicar una imagen del stage.
export function lightboxMediaFrom(galleryEl, stageIndex) {
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

// ----- wiring del visor (idempotente): controles, teclado y swipe -----
// El click que ABRE el lightbox (imagen del stage) lo cablea gallery.js, que
// tiene el contexto de la galería; aquí solo los controles internos del visor.

let wired = false;
export function setupLightbox() {
  if (wired) return;
  wired = true;

  document.addEventListener('click', (e) => {
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
    else if (e.key === 'Tab') trapTab(lightboxEl, e, 'video[controls]');
  });
  // El focus-trap (trapTab) vive en modal.js; el lightbox suma 'video[controls]'
  // a los focusables (un vídeo con controles es tabulable dentro del visor).

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
