// ----- bloque encuesta del composer -----
//
// Toda la UI de creación de encuestas en el composer principal: el toggle del
// botón "encuesta", las filas de opciones (añadir/quitar) y la recogida de
// valores para el submit. Los reply-inline NO llevan encuesta (decisión de
// diseño: una encuesta nace como post root, no como respuesta). La mecánica
// de filas repetibles (add/remove/refresh/toggle) vive en
// composer-repeatable.js, compartida con composer-lyrics.js.
//
// Los topes (min/max opciones, longitud) salen de POLL_LIMITS, que checkAuth
// rellena desde /api/me — el server es la única fuente de verdad. Por eso
// leemos POLL_LIMITS.* en uso (runtime), no en import (que sería el default).

import { POLL_LIMITS } from './state.js';
import { collectRepeatable, wireRepeatableBlock, resetRepeatableBlock } from './composer-repeatable.js';

// Devuelve null si el bloque no existe o está cerrado. Si está abierto,
// devuelve el array de opciones no vacías. Lo usa el submit handler:
//   null  → no incluir `poll` en el payload
//   array → enviar como poll.options (el servidor revalida tamaños)
export function collectPollOptions(pollEl) {
  if (!pollEl || pollEl.hidden) return null;
  return collectRepeatable(pollEl, '.composer-poll-row', (row) => {
    const v = row.querySelector('input')?.value.trim();
    return v || null;
  });
}

// Crea una fila de input para una opción. El botón × sólo se ofrece
// cuando hay más filas que el mínimo (refresh tras add/remove).
function makePollRow() {
  const row = document.createElement('div');
  row.className = 'composer-poll-row';
  row.innerHTML = `
    <input type="text" maxlength="${POLL_LIMITS.optLen}" placeholder="opción" />
    <button type="button" class="poll-remove composer-row-remove" aria-label="quitar opción" hidden>×</button>
  `;
  return row;
}

// Config compartida entre wirePollBlock y resetPollBlock (ver composer-lyrics.js
// para por qué: así el cierre vía × o toggle usa siempre el mismo reset).
const pollBlockConfig = {
  rowsSelector: '.composer-poll-rows',
  rowSelector: '.composer-poll-row',
  removeSelector: '.poll-remove',
  addSelector: '.composer-poll-add',
  closeSelector: '.poll-close',
  getLimits: () => POLL_LIMITS,
  makeRow: makePollRow,
  focusRow: (row) => row?.querySelector('input')?.focus(),
  collect: collectPollOptions,
  discardMessage: '¿descartar la encuesta?',
};

// Cierra y resetea el bloque (lo vuelve al estado inicial de 2 inputs
// vacíos). Se llama tras publicar con éxito o al pulsar la ×.
export function resetPollBlock(pollEl, pollBtn) {
  resetRepeatableBlock(pollEl, pollBtn, pollBlockConfig);
}

// Inicializa el bloque con 2 filas, cablea ×, "+ añadir", y el toggle.
export function wirePollBlock(pollEl, pollBtn) {
  wireRepeatableBlock(pollEl, pollBtn, pollBlockConfig);
}
