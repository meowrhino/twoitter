// ----- UI de letras (lyrics): markup + wiring de pestañas -----
//
// Extraído de render.js: las letras son un subsistema propio (markup del
// bloque + cambio de pestaña activa) ajeno al render de hilos/activación,
// que es la responsabilidad de aquel módulo. renderPost (render.js) invoca
// renderLyrics para el markup y bindLyricsActions para cablear las pestañas.
//
// Esquema del payload:
//   lyrics: {
//     source: string | null,
//     blocks: [{ id, position, label, text }],
//   }

import { escapeHtml, linkify } from './utils.js';

// Markup de un bloque de letras. Con un solo idioma no hace falta fila de
// pestañas (nada que cambiar); con 2+ se pinta una pestaña por bloque, la
// primera activa por defecto. El texto respeta saltos de línea (pre-wrap
// en CSS, igual que .post-text) y va HTML-escapado.
export function renderLyrics(lyrics) {
  if (!lyrics || lyrics.blocks.length === 0) return '';
  const blocks = lyrics.blocks;
  const tabs =
    blocks.length > 1
      ? `<div class="lyrics-tabs">${blocks
          .map(
            (b, i) =>
              `<button type="button" class="lyrics-tab${i === 0 ? ' lyrics-tab-active' : ''}" data-idx="${i}">${escapeHtml(b.label)}</button>`,
          )
          .join('')}</div>`
      : '';
  const sourceLine = lyrics.source
    ? `<div class="lyrics-foot">fuente: ${linkify(lyrics.source)}</div>`
    : '';
  return `
    <div class="lyrics" data-lyrics>
      ${tabs}
      <div class="lyrics-panel">${escapeHtml(blocks[0].text)}</div>
      ${sourceLine}
    </div>
  `;
}

// Wire de las pestañas: cambia el panel visible sin fetch (los bloques ya
// vienen todos en el payload del post). stopPropagation: en el feed, un
// clic en una pestaña no debe activar el post (lo gestiona activation.js).
export function bindLyricsActions(postEl, p) {
  if (!p.lyrics) return;
  const block = postEl.querySelector(':scope > .post-body .lyrics');
  if (!block) return;
  const tabs = block.querySelectorAll('.lyrics-tab');
  if (tabs.length === 0) return;
  const blocks = p.lyrics.blocks;
  const panel = block.querySelector('.lyrics-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(tab.dataset.idx, 10);
      const b = blocks[idx];
      if (!b || !panel) return;
      tabs.forEach((t) => t.classList.remove('lyrics-tab-active'));
      tab.classList.add('lyrics-tab-active');
      panel.textContent = b.text;
    });
  });
}
