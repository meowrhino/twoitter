// ----- primitivas compartidas de galería + lightbox -----
//
// Lo común a la galería del feed (gallery.js) y al visor modal (lightbox.js):
// el HTML de un medio, leer la lista de medios de una galería, precargar una
// imagen y el crossfade con FLIP de altura. Vive aparte para que lightbox.js no
// tenga que importar de gallery.js (evita un ciclo gallery↔lightbox).

import { escapeHtml, nextFrame, wait, prefersReducedMotion } from './utils.js';
import { audioPlayerMarkup } from './audio-player.js';

// Duración de cada fase (fade-out y fade-in/altura). Debe coincidir con
// la CSS: .gallery > .stage / .lightbox-stage  transition: ... Xms ...
// 240ms con cubic-bezier(0.4, 0, 0.2, 1) — suave sin sentirse lento.
// Si el usuario tiene prefers-reduced-motion, saltamos toda la animación
// para no quedarnos 240ms con el stage en blanco (la CSS también respeta
// el flag y deja la transición instantánea).
export const FADE_MS = prefersReducedMotion() ? 0 : 240;

// Defensa en profundidad: r2_key viene de BD pero se interpola en atributos
// HTML. Si alguna vez se cuela un valor con comillas (manual, migración,
// export-import), escaparlo evita inyección de atributos / XSS.
export function mediaItemHtml(m) {
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

export function readMedia(galleryEl) {
  try {
    const arr = JSON.parse(galleryEl.dataset.media || '[]');
    return arr.map((m) => ({ kind: m.k, r2_key: m.r, thumb_key: m.t, id: m.id ?? null, transcript: m.tr || null }));
  } catch { return []; }
}

// Decodifica la imagen en caché antes de insertarla en el DOM. Así, cuando
// el <img> aparezca, sus píxeles ya están listos y no hay flash de placeholder
// ni de la imagen vecina. Si el navegador no soporta decode(), cae a un
// onload/onerror con timeout de seguridad para no bloquear los tests.
export function preloadImage(url) {
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

// Núcleo del crossfade con FLIP de altura, compartido por el carrete (swapStage)
// y el lightbox (renderLightbox). Protocolo:
//   1. snapshot de la altura actual + lock + .is-fading (fade-out por CSS)
//   2. espera EN PARALELO al fade-out y al preload (gana el más lento)
//   3. race-guard: si otra navegación nos superó (isCurrent() falso), abortar
//      SIN tocar el height — lo limpiará el ganador (que siempre llega al
//      setTimeout final), así nunca queda la altura bloqueada permanentemente
//   4. pausa vídeos (audio fantasma) y pinta el contenido nuevo (paint())
//   5. mide la altura natural, re-ancla a fromH, fuerza un frame, anima a toH +
//      quita .is-fading, y limpia el lock tras la transición
// `preload` es una promesa o null; `paint()` mete el contenido en el stage;
// `isCurrent()` es el race-guard (true si esta llamada sigue siendo la última).
export async function crossfadeSwap(stage, { preload, paint, isCurrent }) {
  const fromH = stage.getBoundingClientRect().height;
  stage.style.height = `${fromH}px`;
  stage.classList.add('is-fading');
  await Promise.all([preload || Promise.resolve(), wait(FADE_MS)]);
  if (!isCurrent()) return; // nos superaron; el ganador limpia el height

  stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
  paint();

  const toH = measureNaturalHeight(stage);
  stage.style.height = `${fromH}px`;
  await nextFrame();
  if (!isCurrent()) return;

  // Disparar a la vez: height fromH → toH y opacity 0 → 1.
  stage.style.height = `${toH}px`;
  stage.classList.remove('is-fading');
  setTimeout(() => { if (isCurrent()) stage.style.height = ''; }, FADE_MS + 80);
}
