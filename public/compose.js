// ----- entry de la página /compose (ligera) -----
//
// Página aparte SOLO para publicar, pensada para conexiones malas: carga el
// composer (texto + media + audio + ubicación + encuesta) SIN el timeline,
// render, gallery, rails ni editor. Por eso importa composer.js (ya desacoplado
// de render.js tras extraer makeInlineComposer a inline-composer.js) y poco más.
// El composer principal sigue existiendo en la TL (/); esto es un duplicado.

import { checkAuth, isAuthed } from './js/auth.js';
import { setupGlobalPasteHandler, wireComposer } from './js/composer.js';
import { setupAudioPlayers } from './js/audio-player.js';
import { toast } from './js/utils.js';
import { setupOutbox } from './js/outbox.js';

const $ = (s) => document.querySelector(s);

// Limpieza del coi-serviceworker viejo (igual que app.js): COOP/COEP los sirve
// ahora el Worker, así que no hace falta y no queremos sus recargas.
navigator.serviceWorker?.getRegistrations?.()
  .then((regs) =>
    regs.forEach((r) => {
      if (r.active?.scriptURL.includes('coi-serviceworker')) r.unregister();
    }),
  )
  .catch(() => {});

// PWA offline: mismo sw.js que la TL (app shell network-first). Registrarlo
// también aquí cubre a quien entra directo a /compose desde el icono.
navigator.serviceWorker?.register?.('/sw.js').catch(() => {});

(async () => {
  await checkAuth();
  // Esta página es solo para publicar: si no estás logueado, al login.
  if (!isAuthed()) {
    location.href = '/login.html';
    return;
  }
  setupGlobalPasteHandler();
  setupAudioPlayers(); // para el preview de la nota de voz grabada

  // Cola offline: aquí no hay timeline que recargar — solo confirmamos.
  setupOutbox({
    onPublished: (n) =>
      toast(n === 1 ? 'publicado 1 pendiente ✓' : `publicados ${n} pendientes ✓`),
  });

  wireComposer({
    form: $('#composer'),
    text: $('#text'),
    preview: $('#mediaPreview'),
    fileInput: $('#fileInput'),
    recordBtn: $('#btnRecord'),
    pollEl: $('#composerPoll'),
    pollBtn: $('#btnPoll'),
    lyricsEl: $('#composerLyrics'),
    lyricsBtn: $('#btnLyrics'),
    parentId: null,
    // Sin timeline que actualizar: confirmamos con un toast. wireComposer ya
    // limpia el form (texto/preview/encuesta/ubicación) al publicar con éxito.
    onPosted: () => toast('publicado ✓'),
  });
})();
