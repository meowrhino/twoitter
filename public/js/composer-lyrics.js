// ----- bloque de letras (lyrics) del composer -----
//
// Igual patrón que composer-poll.js: toggle del botón "letras", filas
// repetibles (añadir/quitar) y recogida de valores para el submit. Cada
// fila es una versión/idioma (label libre: "original", "romaji", "english"…)
// con su textarea; un input único de "fuente" cita de dónde sale. La mecánica
// de filas repetibles vive en composer-repeatable.js, compartida con
// composer-poll.js.
//
// Los topes (min/max bloques, longitudes) salen de LYRICS_LIMITS, que
// checkAuth rellena desde /api/me — el server es la única fuente de verdad.

import { LYRICS_LIMITS } from './state.js';
import { collectRepeatable, wireRepeatableBlock, resetRepeatableBlock } from './composer-repeatable.js';

// Devuelve null si el bloque no existe, está cerrado, o no queda ningún
// bloque con texto. Si hay contenido, devuelve { source, blocks }. Lo usa
// el submit handler: null → no incluir `lyrics` en el payload.
export function collectLyrics(lyricsEl) {
  if (!lyricsEl || lyricsEl.hidden) return null;
  const blocks = collectRepeatable(lyricsEl, '.composer-lyrics-row', (row) => {
    const label = row.querySelector('.lyrics-label')?.value.trim() || '';
    const text = row.querySelector('.lyrics-text')?.value.trim() || '';
    return text ? { label, text } : null;
  });
  if (blocks.length === 0) return null;
  const source = lyricsEl.querySelector('.composer-lyrics-source')?.value.trim() || '';
  return { source, blocks };
}

function makeLyricsRow() {
  const row = document.createElement('div');
  row.className = 'composer-lyrics-row';
  row.innerHTML = `
    <div class="composer-lyrics-row-head">
      <input type="text" class="lyrics-label" maxlength="${LYRICS_LIMITS.labelLen}" placeholder="idioma / versión (ej. original, romaji, english)" />
      <button type="button" class="lyrics-remove composer-row-remove" aria-label="quitar idioma" hidden>×</button>
    </div>
    <textarea class="lyrics-text" maxlength="${LYRICS_LIMITS.textLen}" placeholder="pega aquí los chords en este idioma…"></textarea>
  `;
  return row;
}

// Config compartida entre wireLyricsBlock y resetLyricsBlock: el cierre (×
// o toggle) resetea vía este mismo objeto, así el onReset (limpiar la fuente)
// se aplica siempre, no solo cuando se llama a resetLyricsBlock directamente.
const lyricsBlockConfig = {
  rowsSelector: '.composer-lyrics-rows',
  rowSelector: '.composer-lyrics-row',
  removeSelector: '.lyrics-remove',
  addSelector: '.composer-lyrics-add',
  closeSelector: '.lyrics-close',
  getLimits: () => LYRICS_LIMITS,
  makeRow: makeLyricsRow,
  focusRow: (row) => row?.querySelector('.lyrics-label')?.focus(),
  collect: collectLyrics,
  discardMessage: '¿descartar las letras?',
  onReset: (el) => {
    const source = el.querySelector('.composer-lyrics-source');
    if (source) source.value = '';
  },
};

// Cierra y resetea el bloque (rows + fuente vacíos, oculto). Se llama tras
// publicar con éxito o al pulsar la ×.
export function resetLyricsBlock(lyricsEl, lyricsBtn) {
  resetRepeatableBlock(lyricsEl, lyricsBtn, lyricsBlockConfig);
}

// Inicializa el bloque con 1 fila, cablea ×, "+ añadir", y el toggle.
export function wireLyricsBlock(lyricsEl, lyricsBtn) {
  wireRepeatableBlock(lyricsEl, lyricsBtn, lyricsBlockConfig);
}
