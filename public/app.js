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

import { checkAuth } from './js/auth.js';
import { setupMenu, setupFilterBanner } from './js/menu.js';
import { setupGlobalPasteHandler } from './js/composer.js';
import { setupTapToActivate } from './js/render.js';
import { setupGallery } from './js/gallery.js';
import { setupAudioPlayers } from './js/audio-player.js';
import { loadHashtags } from './js/hashtags.js';
import { loadTimeline, setupTimelineComposer } from './js/pages.js';

(async () => {
  await checkAuth();
  setupMenu();
  setupGlobalPasteHandler();
  setupTapToActivate();
  setupGallery();
  setupAudioPlayers();

  setupTimelineComposer();
  setupFilterBanner();
  loadTimeline(true);
  if (!document.body.classList.contains('sidebar-hidden')) {
    loadHashtags();
  }
})();
