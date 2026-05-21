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
//   js/rails.js      → extendRails + notifyThreadChanged
//   js/pages.js      → loadTimeline, loadSinglePost, setupComposers

import { PAGE } from './js/state.js';
import { checkAuth } from './js/auth.js';
import { setupMenu, setupFilterBanner } from './js/menu.js';
import { setupGlobalPasteHandler } from './js/composer.js';
import { setupTapToActivate } from './js/render.js';
import { setupResizeRailRecalc } from './js/rails.js';
import { loadHashtags } from './js/hashtags.js';
import {
  loadTimeline, setupTimelineComposer,
  loadSinglePost, setupReplyForm,
} from './js/pages.js';

(async () => {
  await checkAuth();
  setupMenu();
  setupGlobalPasteHandler();
  setupTapToActivate();
  setupResizeRailRecalc();

  if (PAGE === 'timeline') {
    setupTimelineComposer();
    setupFilterBanner();
    loadTimeline(true);
    if (!document.body.classList.contains('sidebar-hidden')) {
      loadHashtags();
    }
  } else if (PAGE === 'post') {
    await loadSinglePost();
    setupReplyForm();
  }
})();
