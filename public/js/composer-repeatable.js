// ----- mecánica compartida de bloque con filas repetibles -----
//
// Encuesta y letras comparten el mismo patrón en el composer: un bloque
// colapsable con filas repetibles entre min..max (límites del server vía
// /api/me), botón "+ añadir", × por fila (oculto por debajo del mínimo) y un
// toggle abrir/cerrar que pide confirmación de descarte si hay contenido.
// Este módulo aísla esa mecánica; composer-poll.js y composer-lyrics.js
// aportan su propia fila (makeRow) y su propia extracción de valores
// (collect).

// Recoge los valores de cada fila visible del bloque. extractRow(row) debe
// devolver el item, o null/undefined para descartar la fila (p.ej. vacía).
export function collectRepeatable(blockEl, rowSelector, extractRow) {
  if (!blockEl || blockEl.hidden) return [];
  const items = [];
  for (const row of blockEl.querySelectorAll(rowSelector)) {
    const item = extractRow(row);
    if (item != null) items.push(item);
  }
  return items;
}

// Reajusta los × y el botón "+ añadir" tras cada add/remove.
function refresh(blockEl, cfg) {
  const { min, max } = cfg.getLimits();
  const rows = blockEl.querySelectorAll(cfg.rowSelector);
  rows.forEach((r, i) => {
    const x = r.querySelector(cfg.removeSelector);
    if (x) x.hidden = i < min;
  });
  const add = blockEl.querySelector(cfg.addSelector);
  if (add) add.hidden = rows.length >= max;
}

// Cierra y resetea el bloque (rows vacías + hidden). cfg.onReset(blockEl) es
// el hook para campos extra (p.ej. el input de fuente de las letras).
export function resetRepeatableBlock(blockEl, toggleBtn, cfg) {
  if (!blockEl) return;
  const rowsWrap = blockEl.querySelector(cfg.rowsSelector);
  if (rowsWrap) rowsWrap.innerHTML = '';
  cfg.onReset?.(blockEl);
  blockEl.hidden = true;
  if (toggleBtn) toggleBtn.setAttribute('aria-pressed', 'false');
}

// Inicializa el bloque: filas mínimas, ×, "+ añadir" y el toggle abrir/cerrar.
export function wireRepeatableBlock(blockEl, toggleBtn, cfg) {
  if (!blockEl || !toggleBtn) return;
  const rowsWrap = blockEl.querySelector(cfg.rowsSelector);
  const addBtn = blockEl.querySelector(cfg.addSelector);
  const closeBtn = cfg.closeSelector ? blockEl.querySelector(cfg.closeSelector) : null;

  function hasContent() {
    const val = cfg.collect(blockEl);
    return Array.isArray(val) ? val.length > 0 : val !== null;
  }

  function ensureMinRows() {
    const { min } = cfg.getLimits();
    while (rowsWrap.children.length < min) rowsWrap.appendChild(cfg.makeRow());
    refresh(blockEl, cfg);
  }

  // Delegación: × se gestiona en el wrapper de filas.
  rowsWrap.addEventListener('click', (e) => {
    const rm = e.target.closest?.(cfg.removeSelector);
    if (!rm) return;
    const row = rm.closest(cfg.rowSelector);
    if (!row) return;
    if (rowsWrap.children.length <= cfg.getLimits().min) return;
    row.remove();
    refresh(blockEl, cfg);
  });

  addBtn.addEventListener('click', () => {
    if (rowsWrap.children.length >= cfg.getLimits().max) return;
    const row = cfg.makeRow();
    rowsWrap.appendChild(row);
    refresh(blockEl, cfg);
    cfg.focusRow(row);
  });

  closeBtn?.addEventListener('click', () => {
    if (hasContent() && !confirm(cfg.discardMessage)) return;
    resetRepeatableBlock(blockEl, toggleBtn, cfg);
  });

  toggleBtn.addEventListener('click', () => {
    if (blockEl.hidden) {
      ensureMinRows();
      blockEl.hidden = false;
      toggleBtn.setAttribute('aria-pressed', 'true');
      cfg.focusRow(rowsWrap.firstElementChild);
    } else {
      if (hasContent() && !confirm(cfg.discardMessage)) return;
      resetRepeatableBlock(blockEl, toggleBtn, cfg);
    }
  });
}
