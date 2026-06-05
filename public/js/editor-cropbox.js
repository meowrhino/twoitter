// ----- primitiva: caja de recorte (8 tiradores + cuerpo) -----
//
// UI hand-rolled de una caja de recorte libre. Vive dentro de un "overlay" que
// el modal (editor.js) coloca EXACTAMENTE sobre el rect de contenido del medio
// (descontado el letterbox). Así esta primitiva sólo razona en su propio espacio
// [0..W]×[0..H] = tamaño del overlay = tamaño del contenido; el modal se encarga
// del posicionamiento absoluto.
//
// El rect se guarda como FRACCIÓN (0..1) del contenido para que sobreviva a los
// resizes/rotaciones: al cambiar el tamaño, la misma fracción se re-pinta a los
// nuevos px (el modal llama setBox). La matemática de constraints/mapeo es pura
// y vive en editor-geom.js (testeada sin DOM).

import { solveCropConstraints, cropSourceRect } from './editor-geom.js';

const HANDLES = ['NW', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W'];

// Crea una caja de recorte dentro de `overlayEl`. Devuelve un controlador.
export function createCropBox(overlayEl) {
  let frac = { x: 0, y: 0, w: 1, h: 1 }; // rect en fracción del contenido
  let W = 0;
  let H = 0; // tamaño actual del contenido (px)
  let drag = null; // { mode, startX, startY, startRect }

  const rect = document.createElement('div');
  rect.className = 'cropbox-rect';
  for (const h of HANDLES) {
    const k = document.createElement('span');
    k.className = `cropbox-handle cropbox-${h.toLowerCase()}`;
    k.dataset.handle = h;
    rect.appendChild(k);
  }
  overlayEl.appendChild(rect);

  const pxRect = () => ({ x: frac.x * W, y: frac.y * H, w: frac.w * W, h: frac.h * H });

  function render() {
    const r = pxRect();
    rect.style.left = `${r.x}px`;
    rect.style.top = `${r.y}px`;
    rect.style.width = `${r.w}px`;
    rect.style.height = `${r.h}px`;
  }

  function setFromPx(r) {
    frac = {
      x: W ? r.x / W : 0,
      y: H ? r.y / H : 0,
      w: W ? r.w / W : 1,
      h: H ? r.h / H : 1,
    };
  }

  function localPoint(e) {
    const b = overlayEl.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  function onDown(e) {
    let mode;
    const handle = e.target?.dataset?.handle;
    if (handle) mode = handle;
    else if (e.target === rect) mode = 'BODY';
    else mode = 'NEW'; // pointerdown en el fondo atenuado → dibujar caja nueva
    const p = localPoint(e);
    if (mode === 'NEW') {
      // ancla la caja en el punto y arrástrala como esquina inferior-derecha
      frac = { x: W ? p.x / W : 0, y: H ? p.y / H : 0, w: 0, h: 0 };
      mode = 'SE';
    }
    drag = { mode, startX: p.x, startY: p.y, startRect: pxRect() };
    overlayEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!drag) return;
    const p = localPoint(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    const s = drag.startRect;
    const mode = drag.mode;
    const r = { ...s };
    if (mode === 'BODY') {
      r.x = s.x + dx;
      r.y = s.y + dy;
    } else {
      // Sólo se mueven los bordes del modo; el opuesto queda como ancla. El
      // solver (editor-geom) clampa contra límites y lado mínimo.
      if (mode.includes('W')) { r.x = s.x + dx; r.w = s.w - dx; }
      if (mode.includes('E')) { r.w = s.w + dx; }
      if (mode.includes('N')) { r.y = s.y + dy; r.h = s.h - dy; }
      if (mode.includes('S')) { r.h = s.h + dy; }
    }
    setFromPx(solveCropConstraints(r, mode, W, H));
    render();
  }

  function onUp(e) {
    if (!drag) return;
    drag = null;
    overlayEl.releasePointerCapture?.(e.pointerId);
  }

  overlayEl.addEventListener('pointerdown', onDown);
  overlayEl.addEventListener('pointermove', onMove);
  overlayEl.addEventListener('pointerup', onUp);
  overlayEl.addEventListener('pointercancel', onUp);

  return {
    // El modal llama esto al abrir y en cada resize (mismo frac, nuevos px).
    setBox({ width, height }) {
      W = width;
      H = height;
      render();
    },
    setFraction(f) {
      frac = { x: f.x, y: f.y, w: f.w, h: f.h };
      render();
    },
    getFraction() {
      return { ...frac };
    },
    // Crop en px de ORIGEN dado el displayBox (lleva srcW/srcH). null si cubre
    // casi todo el frame (= sin recorte) → el caller omite el crop.
    getCropSource(displayBox) {
      return cropSourceRect(pxRect(), displayBox);
    },
    destroy() {
      overlayEl.removeEventListener('pointerdown', onDown);
      overlayEl.removeEventListener('pointermove', onMove);
      overlayEl.removeEventListener('pointerup', onUp);
      overlayEl.removeEventListener('pointercancel', onUp);
      rect.remove();
    },
  };
}
