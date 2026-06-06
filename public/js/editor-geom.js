// ----- geometría pura del editor de medios (sin DOM) -----
//
// Todo lo "matemático" del editor vive aquí, separado de la UI, para poder
// testearlo con vitest sin navegador (ni pointer, ni canvas, ni ffmpeg). Las
// primitivas de UI (editor-cropbox.js, editor-trimtrack.js) importan de aquí.
//
// Convención de coordenadas:
//   - "display"  → píxeles en pantalla, relativos al rect de CONTENIDO del
//                  medio (no al border-box): (0,0) = esquina del contenido ya
//                  descontado el letterbox de object-fit:contain.
//   - "source"   → píxeles del medio original (el bitmap/vídeo sin escalar).
// Una caja de recorte se mueve en display y se aplica en source.

// Lado mínimo de la caja de recorte, en px de display: por debajo los tiradores
// se solapan y no se pueden agarrar. Se exporta para que la primitiva lo reuse.
export const MIN_CROP = 24;

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

// Resuelve un redimensionado/movimiento de la caja contra los límites [0..BW]×
// [0..BH] (BW/BH = tamaño del contenido en display). `mode` indica qué se mueve:
//   - 'BODY'                  → traslación (tamaño fijo)
//   - combinación de N/S/E/W  → arrastre de un borde o esquina ('NW','E', …)
//
// Modelo por BORDES: el borde OPUESTO al que se arrastra queda fijo (lo tomamos
// del rect de entrada), y el borde que se mueve se clampa entre el límite del
// lienzo y la distancia mínima al ancla. Es exacto y sin casos raros de "empujar
// el ancla", que es donde suelen aparecer bugs.
export function solveCropConstraints(rect, mode, BW, BH, min = MIN_CROP) {
  // En medios diminutos el mínimo no puede exceder el lienzo.
  const m = Math.max(1, Math.min(min, BW, BH));

  if (mode === 'BODY') {
    const w = clamp(rect.w, m, BW);
    const h = clamp(rect.h, m, BH);
    return { x: clamp(rect.x, 0, BW - w), y: clamp(rect.y, 0, BH - h), w, h };
  }

  // Bordes actuales; los que no se mueven se quedan como vienen (= ancla fija).
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  if (mode.includes('W')) left = clamp(left, 0, right - m);
  if (mode.includes('E')) right = clamp(right, left + m, BW);
  if (mode.includes('N')) top = clamp(top, 0, bottom - m);
  if (mode.includes('S')) bottom = clamp(bottom, top + m, BH);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

// Dado el border-box del elemento media (getBoundingClientRect) y las dims del
// origen, devuelve el rect del CONTENIDO realmente pintado bajo object-fit:
// contain (centrado, con barras de letterbox descontadas). Es a este rect al
// que se ancla la caja de recorte; usar el border-box desalinea el recorte
// cuando el aspect ratio del medio ≠ el del hueco.
export function computeDisplayBox(elemBox, srcW, srcH) {
  const { left, top, width, height } = elemBox;
  if (!(width > 0) || !(height > 0) || !(srcW > 0) || !(srcH > 0)) {
    return { left, top, width, height, srcW, srcH };
  }
  const elemAR = width / height;
  const srcAR = srcW / srcH;
  let cw, ch;
  if (srcAR > elemAR) {
    // limitado por ancho: barras arriba/abajo
    cw = width;
    ch = width / srcAR;
  } else {
    // limitado por alto: barras a los lados
    ch = height;
    cw = height * srcAR;
  }
  return {
    left: left + (width - cw) / 2,
    top: top + (height - ch) / 2,
    width: cw,
    height: ch,
    srcW,
    srcH,
  };
}

// Mapea un rect de la caja (display, relativo al contenido) a píxeles de origen.
// Devuelve null como sentinela "no hay recorte" cuando cubre casi todo el frame
// (margen < 1px en origen) → el caller omite el crop y deja la salida idéntica
// al camino sin editar.
export function cropSourceRect(rect, displayBox) {
  const s = displayBox.srcW / displayBox.width; // factor uniforme (contain)
  const sx = clamp(rect.x * s, 0, displayBox.srcW);
  const sy = clamp(rect.y * s, 0, displayBox.srcH);
  const sw = clamp(rect.w * s, 1, displayBox.srcW - sx);
  const sh = clamp(rect.h * s, 1, displayBox.srcH - sy);
  const full =
    sx <= 1 &&
    sy <= 1 &&
    sw >= displayBox.srcW - 1 &&
    sh >= displayBox.srcH - 1;
  return full ? null : { sx, sy, sw, sh };
}

// Inversa de cropSourceRect: de un crop guardado (source) al rect de la caja
// (display). Sirve para re-sembrar la caja con el último recorte al reabrir el
// editor (edición no-destructiva: se ve, pero al aplicar se re-deriva del
// original).
export function sourceCropToDisplay(crop, displayBox) {
  const s = displayBox.width / displayBox.srcW;
  return { x: crop.sx * s, y: crop.sy * s, w: crop.sw * s, h: crop.sh * s };
}

// Redondea un crop a dimensiones PARES (libvpx las exige) manteniéndolo dentro
// del frame. Floor a par en w/h (mín 2) y offset par en x/y.
export function roundEvenCrop(crop, srcW, srcH) {
  const evenFloor = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const evenOffset = (n) => Math.max(0, Math.floor(n / 2) * 2);
  let w = evenFloor(crop.w);
  let h = evenFloor(crop.h);
  let x = evenOffset(clamp(crop.x, 0, srcW - w));
  let y = evenOffset(clamp(crop.y, 0, srcH - h));
  if (x + w > srcW) w = evenFloor(srcW - x);
  if (y + h > srcH) h = evenFloor(srcH - y);
  return { x, y, w, h };
}

// Escala las dimensiones de un recorte para que el lado largo no pase de maxDim
// (igual política que la imagen completa). Devuelve las dims del canvas destino.
export function cropAndScaleDims(sw, sh, maxDim) {
  let w = sw;
  let h = sh;
  if (sw > maxDim || sh > maxDim) {
    const r = sw > sh ? maxDim / sw : maxDim / sh;
    w = Math.round(sw * r);
    h = Math.round(sh * r);
  }
  return { w, h };
}

// Mapea una X de puntero (clientX) a segundos sobre una pista de tiempo. `rect`
// es el getBoundingClientRect de la pista ({ left, width }); se inyecta para que
// la función sea pura y testeable. Espeja la matemática de seekFromPointer.
export function pxToTime(clientX, rect, duration) {
  if (!(rect.width > 0) || !(duration > 0)) return 0;
  const f = clamp((clientX - rect.left) / rect.width, 0, 1);
  return f * duration;
}

// ----- recorte temporal (trim): vídeo / audio -----

// Duración mínima del clip recortado, en segundos: por debajo los dos tiradores
// se solapan. Se exporta para que la pista (editor-trimtrack.js) lo reuse.
export const MIN_TRIM = 0.3;

// Resuelve el arrastre de un borde del rango de recorte temporal [start, end]
// contra [0, duration], con duración mínima `min`. `edge`:
//   - 'start' | 'end' → mueve ese borde; el opuesto queda fijo (ancla)
//   - 'body'          → traslada la ventana entera (tamaño fijo)
// Modelo por bordes, igual que solveCropConstraints: exacto y sin "empujar el
// ancla". Devuelve { start, end } clampados.
export function solveTrimConstraints(range, edge, duration, min = MIN_TRIM) {
  const m = Math.max(0, Math.min(min, duration));
  let { start, end } = range;
  if (edge === 'body') {
    const len = end - start;
    start = clamp(start, 0, duration - len);
    return { start, end: start + len };
  }
  if (edge === 'start') start = clamp(start, 0, end - m);
  if (edge === 'end') end = clamp(end, start + m, duration);
  return { start, end };
}

// Convierte un rango [start, end] (segundos) al { start, duration } que consumen
// trimAudio / buildVideoArgs. Devuelve null (centinela "sin recorte") cuando el
// rango cubre casi todo el clip (margen < eps en ambos extremos) → el caller
// omite el trim y la salida queda idéntica al camino sin editar.
export function rangeToTrim(range, duration, eps = 0.05) {
  const full = range.start <= eps && range.end >= duration - eps;
  return full ? null : { start: range.start, duration: range.end - range.start };
}
