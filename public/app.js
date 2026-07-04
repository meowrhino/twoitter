// ----- entry point: arranque y orquestación -----
//
// Este archivo solo orquesta: cada módulo se ocupa de su área.
// Estructura:
//   js/state.js      → constantes y estado compartido (composerState)
//   js/utils.js      → $, $$, escapeHtml, linkify, fmt, toast, etc.
//   js/auth.js       → checkAuth, isAuthed, applyAuthVisibility
//   js/hashtags.js   → loadHashtags, refreshHashtags (sidebar)
//   js/menu.js       → menú hamburguesa, buscador, filter banner
//   js/media.js      → uploadMedia + preview items + attachFile
//   js/composer.js   → wireComposer, makeInlineComposer, paste global
//   js/render.js     → renderPost, renderThread, bindings
//   js/rails.js      → getThreadRoot, notifyThreadChanged (rails son CSS puro)
//   js/pages.js      → loadTimeline, setupTimelineComposer
//
// Ya no hay vista single-post (post.html): la TL es un carrete plano y un
// link a un post es la URL /#<id>. /post/:id (legado) redirige 301.

import { checkAuth, isAuthed } from './js/auth.js';
import { setupMenu, setupFilterBanner } from './js/menu.js';
import { setupGlobalPasteHandler } from './js/composer.js';
import { setupTapToActivate } from './js/render.js';
import { setupGallery } from './js/gallery.js';
import { setupAudioPlayers } from './js/audio-player.js';
import { setupEditor } from './js/editor.js';
import { loadHashtags } from './js/hashtags.js';
import { loadTimeline, setupTimelineComposer } from './js/pages.js';
import { pendingCount, processQueue } from './js/queue.js';
import { setupOutbox } from './js/outbox.js';
import { toast } from './js/utils.js';

// Vacía la cola offline de NOTAS DE VOZ (queue.js: sube, publica y transcribe
// las pendientes). Se llama al arrancar y al evento 'online'. Solo con
// sesión: sin auth el upload daría 401 y quemaría intentos para nada.
// La cola GENÉRICA (texto/imágenes/vídeo/encuesta/letras, sin transcripción)
// vive aparte en outbox.js — ver setupOutbox más abajo.
async function flushQueue() {
  if (!isAuthed()) return;
  try {
    if ((await pendingCount()) === 0) return;
    const n = await processQueue((msg) => toast(msg, 'info'));
    if (n > 0) {
      toast(`${n} nota${n > 1 ? 's' : ''} pendiente${n > 1 ? 's' : ''} publicada${n > 1 ? 's' : ''}`, 'info');
      loadTimeline(true);
    }
  } catch (err) {
    // la red volvió a caerse o similar: lo que quede sigue en la cola
    console.error('flushQueue', err);
  }
}

// Limpieza: el coi-serviceworker.js de versiones anteriores quedaba instalado y
// seguía forzando recargas. Ahora COOP/COEP los sirve el Worker, así que lo
// desregistramos para usuarios que vuelven. No recargamos (esta carga ya llega
// aislada por las cabeceras del Worker).
navigator.serviceWorker?.getRegistrations?.()
  .then((regs) =>
    regs.forEach((r) => {
      if (r.active?.scriptURL.includes('coi-serviceworker')) r.unregister();
    }),
  )
  .catch(() => {});

// SW propio: shell disponible offline (network-first, ver sw.js). Mejora
// progresiva pura — la app y ambas colas offline funcionan igual sin él.
navigator.serviceWorker?.register?.('/sw.js').catch(() => {});

(async () => {
  await checkAuth();
  window.addEventListener('online', flushQueue);
  flushQueue(); // notas grabadas sin red en una sesión anterior
  setupMenu();
  setupGlobalPasteHandler();
  setupTapToActivate();
  setupGallery();
  setupAudioPlayers();
  setupEditor();

  setupTimelineComposer();
  setupFilterBanner();

  // Cola genérica (outbox.js): publica lo que quedó pendiente de otra sesión
  // (texto/imágenes/vídeo/encuesta/letras) y se suscribe al evento 'online'.
  // Al publicar, recarga la TL para que los posts recién salidos aparezcan.
  setupOutbox({
    onPublished: (n) => {
      toast(n === 1 ? 'publicado 1 pendiente ✓' : `publicados ${n} pendientes ✓`);
      loadTimeline(true);
    },
  });

  loadTimeline(true);
  if (!document.body.classList.contains('sidebar-hidden')) {
    loadHashtags();
  }
})();
