// ----- auth check + visibilidad anon/authed -----

import { $, $$ } from './utils.js';
import { SIDEBAR_KEY } from './state.js';

// Estado interno mutable: solo lo modifica este módulo. Los demás
// preguntan vía isAuthed() (live binding también funciona, pero la
// función deja la intención más explícita en los call sites).
let IS_AUTHED = false;
export const isAuthed = () => IS_AUTHED;

export async function checkAuth() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    IS_AUTHED = !!d.authed;
  } catch {
    IS_AUTHED = false;
  }
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
