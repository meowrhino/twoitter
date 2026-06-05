// ----- auth check + visibilidad anon/authed -----

import { $, $$ } from './utils.js';
import { SIDEBAR_KEY, POLL_LIMITS, MEDIA_LIMITS } from './state.js';
import { api } from './api.js';

// Estado interno mutable: solo lo modifica este módulo. Los demás
// preguntan vía isAuthed() (live binding también funciona, pero la
// función deja la intención más explícita en los call sites).
let IS_AUTHED = false;
export const isAuthed = () => IS_AUTHED;

export async function checkAuth() {
  const { ok, data } = await api('/api/me');
  IS_AUTHED = ok && !!data?.authed;
  // Sincroniza los límites (encuesta + tamaño de media) con los del server.
  if (data?.poll) Object.assign(POLL_LIMITS, data.poll);
  if (data?.media) Object.assign(MEDIA_LIMITS, data.media);
  applyAuthVisibility();
}

export function applyAuthVisibility() {
  for (const el of $$('[data-authed-only]')) el.hidden = !IS_AUTHED;
  for (const el of $$('[data-anon-only]')) el.hidden = IS_AUTHED;
  document.body.classList.toggle('anon', !IS_AUTHED);
  document.body.classList.toggle('authed', IS_AUTHED);
  // sidebar plegado por defecto, abierto solo si el usuario lo pidió
  const shown = IS_AUTHED && localStorage.getItem(SIDEBAR_KEY) === 'open';
  document.body.classList.toggle('sidebar-hidden', !shown);
  const tog = $('#toggleSidebar');
  if (tog) tog.textContent = shown ? 'ocultar #tags' : 'mostrar #tags';
}
