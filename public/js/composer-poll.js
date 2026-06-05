// ----- bloque encuesta del composer -----
//
// Toda la UI de creación de encuestas en el composer principal: el toggle del
// botón "encuesta", las filas de opciones (añadir/quitar) y la recogida de
// valores para el submit. Los reply-inline NO llevan encuesta (decisión de
// diseño: una encuesta nace como post root, no como respuesta).
//
// Los topes (min/max opciones, longitud) salen de POLL_LIMITS, que checkAuth
// rellena desde /api/me — el server es la única fuente de verdad. Por eso
// leemos POLL_LIMITS.* en uso (runtime), no en import (que sería el default).

import { POLL_LIMITS } from './state.js';

// Devuelve null si el bloque no existe o está cerrado. Si está abierto,
// devuelve el array de opciones no vacías. Lo usa el submit handler:
//   null  → no incluir `poll` en el payload
//   array → enviar como poll.options (el servidor revalida tamaños)
export function collectPollOptions(pollEl) {
  if (!pollEl || pollEl.hidden) return null;
  const inputs = pollEl.querySelectorAll('.composer-poll-row input');
  const opts = [];
  for (const inp of inputs) {
    const v = inp.value.trim();
    if (v) opts.push(v);
  }
  return opts;
}

// Crea una fila de input para una opción. El botón × sólo se ofrece
// cuando hay más filas que el mínimo (refresh tras add/remove).
function makePollRow() {
  const row = document.createElement('div');
  row.className = 'composer-poll-row';
  row.innerHTML = `
    <input type="text" maxlength="${POLL_LIMITS.optLen}" placeholder="opción" />
    <button type="button" class="poll-remove" aria-label="quitar opción" hidden>×</button>
  `;
  return row;
}

// Reajusta los × y el botón "+ añadir" tras cada add/remove.
function refreshPollBlock(pollEl) {
  const rows = pollEl.querySelectorAll('.composer-poll-row');
  const removableFrom = POLL_LIMITS.min; // a partir de la 3ª fila se puede quitar
  rows.forEach((r, i) => {
    const x = r.querySelector('.poll-remove');
    if (x) x.hidden = i < removableFrom;
  });
  const add = pollEl.querySelector('.composer-poll-add');
  if (add) add.hidden = rows.length >= POLL_LIMITS.max;
}

// Cierra y resetea el bloque (lo vuelve al estado inicial de 2 inputs
// vacíos). Se llama tras publicar con éxito o al pulsar la ×.
export function resetPollBlock(pollEl, pollBtn) {
  if (!pollEl) return;
  const rowsWrap = pollEl.querySelector('.composer-poll-rows');
  if (rowsWrap) rowsWrap.innerHTML = '';
  pollEl.hidden = true;
  if (pollBtn) pollBtn.setAttribute('aria-pressed', 'false');
}

// Inicializa el bloque con 2 filas, cablea ×, "+ añadir", y el toggle.
export function wirePollBlock(pollEl, pollBtn) {
  if (!pollEl || !pollBtn) return;
  const rowsWrap = pollEl.querySelector('.composer-poll-rows');
  const addBtn = pollEl.querySelector('.composer-poll-add');
  const closeBtn = pollEl.querySelector('.poll-close');

  function ensureMinRows() {
    while (rowsWrap.children.length < POLL_LIMITS.min) {
      rowsWrap.appendChild(makePollRow());
    }
    refreshPollBlock(pollEl);
  }

  // Delegación: × y validación se gestionan en el wrapper de filas.
  rowsWrap.addEventListener('click', (e) => {
    const rm = e.target.closest?.('.poll-remove');
    if (!rm) return;
    const row = rm.closest('.composer-poll-row');
    if (!row) return;
    if (rowsWrap.children.length <= POLL_LIMITS.min) return;
    row.remove();
    refreshPollBlock(pollEl);
  });

  addBtn.addEventListener('click', () => {
    if (rowsWrap.children.length >= POLL_LIMITS.max) return;
    const row = makePollRow();
    rowsWrap.appendChild(row);
    refreshPollBlock(pollEl);
    row.querySelector('input')?.focus();
  });

  closeBtn?.addEventListener('click', () => {
    resetPollBlock(pollEl, pollBtn);
  });

  pollBtn.addEventListener('click', () => {
    if (pollEl.hidden) {
      ensureMinRows();
      pollEl.hidden = false;
      pollBtn.setAttribute('aria-pressed', 'true');
      pollEl.querySelector('input')?.focus();
    } else {
      // Si hay algo escrito, pedir confirmación de descarte. Si está vacío,
      // cerrar sin más.
      const hasContent = [...pollEl.querySelectorAll('input')].some((i) => i.value.trim());
      if (hasContent && !confirm('¿descartar la encuesta?')) return;
      resetPollBlock(pollEl, pollBtn);
    }
  });
}
