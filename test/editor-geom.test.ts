import { describe, it, expect } from 'vitest';
import {
  clamp,
  solveCropConstraints,
  computeDisplayBox,
  cropSourceRect,
  sourceCropToDisplay,
  roundEvenCrop,
  cropAndScaleDims,
  pxToTime,
  solveTrimConstraints,
  rangeToTrim,
  MIN_CROP,
  MIN_TRIM,
} from '../public/js/editor-geom.js';

describe('clamp', () => {
  it('acota dentro del rango', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('solveCropConstraints', () => {
  const BW = 200;
  const BH = 100;
  // Rect base centrado y holgado para que los arrastres tengan margen.
  const base = { x: 50, y: 25, w: 100, h: 50 };

  it('BODY: traslada manteniendo el tamaño', () => {
    const r = solveCropConstraints({ ...base, x: 70, y: 35 }, 'BODY', BW, BH);
    expect(r).toEqual({ x: 70, y: 35, w: 100, h: 50 });
  });

  it('BODY: clampa la posición para no salirse por la derecha/abajo', () => {
    const r = solveCropConstraints({ ...base, x: 999, y: 999 }, 'BODY', BW, BH);
    expect(r.x).toBe(BW - base.w); // 100
    expect(r.y).toBe(BH - base.h); // 50
    expect(r.w).toBe(100);
    expect(r.h).toBe(50);
  });

  it('BODY: clampa la posición para no salirse por arriba/izquierda', () => {
    const r = solveCropConstraints({ ...base, x: -999, y: -999 }, 'BODY', BW, BH);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('E: mueve el borde derecho, ancla la izquierda', () => {
    // arrastrar la derecha +30 (w pasa de 100 a 130)
    const r = solveCropConstraints({ ...base, w: 130 }, 'E', BW, BH);
    expect(r.x).toBe(50); // izquierda intacta
    expect(r.w).toBe(130);
  });

  it('E: clampa el borde derecho al lienzo', () => {
    const r = solveCropConstraints({ ...base, w: 999 }, 'E', BW, BH);
    expect(r.x).toBe(50);
    expect(r.w).toBe(BW - 50); // 150
  });

  it('W: mueve el borde izquierdo, ancla la derecha (x+w constante)', () => {
    // arrastrar la izquierda +20: x 50→70, w 100→80, derecha sigue en 150
    const r = solveCropConstraints({ x: 70, y: 25, w: 80, h: 50 }, 'W', BW, BH);
    expect(r.x).toBe(70);
    expect(r.x + r.w).toBe(150);
  });

  it('W: respeta el lado mínimo empujando solo el borde que se mueve', () => {
    // intentar colapsar la izquierda más allá del mínimo: derecha fija en 150
    const r = solveCropConstraints({ x: 149, y: 25, w: 1, h: 50 }, 'W', BW, BH);
    expect(r.x + r.w).toBe(150); // ancla derecha intacta
    expect(r.w).toBe(MIN_CROP); // 24
    expect(r.x).toBe(150 - MIN_CROP);
  });

  it('N/S: análogo en vertical', () => {
    const rs = solveCropConstraints({ ...base, h: 80 }, 'S', BW, BH);
    expect(rs.y).toBe(25);
    expect(rs.h).toBe(75); // clampado: 25+80=105 > 100 → h=75
    const rn = solveCropConstraints({ x: 50, y: 40, w: 100, h: 35 }, 'N', BW, BH);
    expect(rn.y + rn.h).toBe(75); // ancla inferior intacta
  });

  it('SE (esquina): mueve abajo-derecha, ancla arriba-izquierda', () => {
    const r = solveCropConstraints({ x: 50, y: 25, w: 130, h: 60 }, 'SE', BW, BH);
    expect(r.x).toBe(50);
    expect(r.y).toBe(25);
    expect(r.w).toBe(130);
    expect(r.h).toBe(60);
  });

  it('NW (esquina): mueve arriba-izquierda, ancla abajo-derecha', () => {
    // derecha=150, abajo=75 deben quedar fijos
    const r = solveCropConstraints({ x: 70, y: 40, w: 80, h: 35 }, 'NW', BW, BH);
    expect(r.x + r.w).toBe(150);
    expect(r.y + r.h).toBe(75);
  });

  it('el mínimo nunca excede el lienzo en medios diminutos', () => {
    const r = solveCropConstraints({ x: 0, y: 0, w: 1, h: 1 }, 'E', 10, 8);
    expect(r.w).toBeLessThanOrEqual(10);
  });
});

describe('computeDisplayBox (letterbox de object-fit:contain)', () => {
  const elem = { left: 0, top: 0, width: 200, height: 100 };

  it('medio más ancho que el hueco → barras arriba/abajo', () => {
    const box = computeDisplayBox(elem, 800, 200); // AR 4 > 2
    expect(box.width).toBe(200);
    expect(box.height).toBe(50); // 200/4
    expect(box.top).toBe(25); // centrado vertical
    expect(box.left).toBe(0);
  });

  it('medio más alto que el hueco → barras a los lados', () => {
    const box = computeDisplayBox(elem, 200, 800); // AR 0.25 < 2
    expect(box.height).toBe(100);
    expect(box.width).toBe(25); // 100*0.25
    expect(box.left).toBe(87.5); // centrado horizontal
    expect(box.top).toBe(0);
  });

  it('mismo AR → llena el hueco sin barras', () => {
    const box = computeDisplayBox(elem, 400, 200); // AR 2 == 2
    expect(box.width).toBe(200);
    expect(box.height).toBe(100);
    expect(box.left).toBe(0);
    expect(box.top).toBe(0);
  });
});

describe('cropSourceRect / sourceCropToDisplay', () => {
  // contenido 100px display = 1000px source → factor 10
  const displayBox = { left: 0, top: 0, width: 100, height: 50, srcW: 1000, srcH: 500 };

  it('mapea display→source con el factor de escala', () => {
    const c = cropSourceRect({ x: 10, y: 5, w: 40, h: 20 }, displayBox);
    expect(c).toEqual({ sx: 100, sy: 50, sw: 400, sh: 200 });
  });

  it('devuelve null (sin crop) cuando cubre casi todo el frame', () => {
    const c = cropSourceRect({ x: 0, y: 0, w: 100, h: 50 }, displayBox);
    expect(c).toBeNull();
  });

  it('clampa a los límites del origen', () => {
    const c = cropSourceRect({ x: 90, y: 45, w: 999, h: 999 }, displayBox);
    expect(c!.sx).toBe(900);
    expect(c!.sw).toBe(100); // 1000-900
    expect(c!.sh).toBe(50); // 500-450
  });

  it('sourceCropToDisplay es la inversa', () => {
    const crop = { sx: 100, sy: 50, sw: 400, sh: 200 };
    expect(sourceCropToDisplay(crop, displayBox)).toEqual({ x: 10, y: 5, w: 40, h: 20 });
  });
});

describe('solveTrimConstraints', () => {
  const D = 10; // duración total del clip (s)

  it('start: mueve el inicio dejando el fin fijo', () => {
    expect(solveTrimConstraints({ start: 3, end: 8 }, 'start', D)).toEqual({ start: 3, end: 8 });
  });
  it('start: no cruza el fin (respeta el mínimo)', () => {
    const r = solveTrimConstraints({ start: 9, end: 8 }, 'start', D, 0.3);
    expect(r.start).toBeCloseTo(7.7); // end - min
    expect(r.end).toBe(8);
  });
  it('start: no baja de 0', () => {
    expect(solveTrimConstraints({ start: -5, end: 8 }, 'start', D).start).toBe(0);
  });
  it('start: usa MIN_TRIM como mínimo por defecto', () => {
    expect(solveTrimConstraints({ start: 9.9, end: 10 }, 'start', D).start).toBeCloseTo(10 - MIN_TRIM);
  });
  it('end: no pasa de la duración', () => {
    expect(solveTrimConstraints({ start: 2, end: 99 }, 'end', D).end).toBe(D);
  });
  it('end: respeta el mínimo respecto al inicio', () => {
    expect(solveTrimConstraints({ start: 5, end: 5 }, 'end', D, 0.3).end).toBeCloseTo(5.3);
  });
  it('body: traslada manteniendo la longitud, clampado al final', () => {
    expect(solveTrimConstraints({ start: 8, end: 12 }, 'body', D)).toEqual({ start: 6, end: 10 });
  });
});

describe('rangeToTrim', () => {
  it('rango completo → null (sin recorte)', () => {
    expect(rangeToTrim({ start: 0, end: 10 }, 10)).toBeNull();
  });
  it('rango casi-completo dentro de eps → null', () => {
    expect(rangeToTrim({ start: 0.02, end: 9.98 }, 10, 0.05)).toBeNull();
  });
  it('rango recortado → { start, duration }', () => {
    expect(rangeToTrim({ start: 2, end: 7 }, 10)).toEqual({ start: 2, duration: 5 });
  });
});

describe('roundEvenCrop (libvpx exige pares)', () => {
  it('redondea w/h/x/y a par y mantiene dentro del frame', () => {
    const c = roundEvenCrop({ x: 3, y: 7, w: 101, h: 51 }, 1920, 1080);
    expect(c.w % 2).toBe(0);
    expect(c.h % 2).toBe(0);
    expect(c.x % 2).toBe(0);
    expect(c.y % 2).toBe(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1920);
    expect(c.y + c.h).toBeLessThanOrEqual(1080);
  });

  it('no se sale aunque el origen sea impar', () => {
    const c = roundEvenCrop({ x: 0, y: 0, w: 999, h: 999 }, 101, 101);
    expect(c.x + c.w).toBeLessThanOrEqual(101);
    expect(c.y + c.h).toBeLessThanOrEqual(101);
    expect(c.w).toBeGreaterThanOrEqual(2);
  });
});

describe('cropAndScaleDims', () => {
  it('no escala si cabe en maxDim', () => {
    expect(cropAndScaleDims(800, 600, 2000)).toEqual({ w: 800, h: 600 });
  });
  it('escala por el lado largo (ancho)', () => {
    expect(cropAndScaleDims(4000, 2000, 2000)).toEqual({ w: 2000, h: 1000 });
  });
  it('escala por el lado largo (alto)', () => {
    expect(cropAndScaleDims(1000, 3000, 2000)).toEqual({ w: 667, h: 2000 });
  });
});

describe('pxToTime', () => {
  const rect = { left: 100, width: 200 };
  it('mapea X a segundos y clampa a [0, duration]', () => {
    expect(pxToTime(100, rect, 60)).toBe(0);
    expect(pxToTime(200, rect, 60)).toBe(30);
    expect(pxToTime(300, rect, 60)).toBe(60);
    expect(pxToTime(9999, rect, 60)).toBe(60);
    expect(pxToTime(-50, rect, 60)).toBe(0);
  });
  it('protege contra rect/duración inválidos', () => {
    expect(pxToTime(150, { left: 0, width: 0 }, 60)).toBe(0);
    expect(pxToTime(150, rect, 0)).toBe(0);
  });
});
