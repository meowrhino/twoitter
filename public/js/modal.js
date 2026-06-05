// ----- modal genérico: scaffold + focus-trap -----
//
// Patrón compartido por el lightbox (gallery.js) y el editor de medios
// (editor.js): un único nodo role=dialog + aria-modal creado a demanda
// (singleton por caller), oculto, y re-añadido al body si se desconectó. Más el
// focus-trap de Tab que cualquier aria-modal necesita. Cuando F6 añada el camino
// de vídeo al editor, construirá sobre esto en vez de clonar el patrón.

// Crea (o reusa) el nodo modal. `existing` es la referencia que guarda el caller
// (null la primera vez); devuelve el elemento y el caller reasigna su variable.
export function ensureModal(existing, { className, label, html }) {
  if (existing && existing.isConnected) return existing;
  if (existing) { document.body.appendChild(existing); return existing; }
  const el = document.createElement('div');
  el.className = className;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label);
  el.hidden = true;
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// Focus-trap: ciclo de Tab dentro del modal (Shift+Tab al revés). Sin esto, Tab
// se va a elementos de detrás del overlay y rompe la promesa de aria-modal=true.
// `extra` añade selectores focusables propios del caller (p.ej. el lightbox suma
// 'video[controls]'). Llamar desde el keydown del caller con e.key === 'Tab'.
export function trapTab(modalEl, e, extra = '') {
  const focusables = modalEl.querySelectorAll(
    `button:not([hidden]):not([disabled]), [href], ${extra ? extra + ', ' : ''}[tabindex]:not([tabindex="-1"])`,
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (!modalEl.contains(active)) {
    // Foco se escapó por algún motivo — devolver al primero.
    e.preventDefault();
    first.focus();
  }
}
