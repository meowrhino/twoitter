// ----- primitiva: pista de recorte temporal (trim) -----
//
// Una barra horizontal con dos tiradores (inicio / fin) que seleccionan un rango
// [start, end] sobre la duración del medio. Es el equivalente 1D de la caja de
// recorte (editor-cropbox.js): el modal (editor.js) la coloca debajo del medio y
// esta primitiva solo razona sobre el tiempo. La matemática (clamp del rango,
// rango→trim) es pura y vive en editor-geom.js (testeada sin DOM).
//
// Posiciona por PORCENTAJE (left/width en %), así reescala sola con el ancho de
// la pista sin re-render en resize. La reproducción/scrub la dan los controles
// nativos del <video> o el player de audio; esta pista SOLO elige el rango.

import { pxToTime, solveTrimConstraints, rangeToTrim, clamp, MIN_TRIM } from './editor-geom.js';

// Crea una pista de trim dentro de `trackEl` para un medio de `duration` segundos.
// Devuelve un controlador.
export function createTrimTrack(trackEl, { duration }) {
  let range = { start: 0, end: duration };
  let drag = null; // { mode: 'start'|'end'|'body', startT, startRange }

  trackEl.classList.add('trimtrack');
  trackEl.innerHTML = `
    <div class="trimtrack-sel" data-role="body"></div>
    <span class="trimtrack-handle trimtrack-start" data-role="start"></span>
    <span class="trimtrack-handle trimtrack-end" data-role="end"></span>
    <span class="trimtrack-label" aria-live="polite"></span>
  `;
  const sel = trackEl.querySelector('.trimtrack-sel');
  const startH = trackEl.querySelector('.trimtrack-start');
  const endH = trackEl.querySelector('.trimtrack-end');
  const label = trackEl.querySelector('.trimtrack-label');

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const pct = (t) => (duration > 0 ? (t / duration) * 100 : 0);

  function render() {
    const a = pct(range.start);
    const b = pct(range.end);
    sel.style.left = `${a}%`;
    sel.style.width = `${b - a}%`;
    startH.style.left = `${a}%`;
    endH.style.left = `${b}%`;
    label.textContent = `${fmt(range.end - range.start)} / ${fmt(duration)}`;
  }

  // clientX → segundos sobre la pista (rect actual, por si cambió el ancho).
  const timeAt = (e) => pxToTime(e.clientX, trackEl.getBoundingClientRect(), duration);

  function onDown(e) {
    const role = e.target?.dataset?.role;
    if (!role) return; // pointerdown en el fondo de la pista → ignorar
    drag = { mode: role, startT: timeAt(e), startRange: { ...range } };
    trackEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    if (!drag) return;
    const t = timeAt(e);
    if (drag.mode === 'body') {
      // Traslada la ventana entera por el delta de tiempo arrastrado.
      const dt = t - drag.startT;
      range = solveTrimConstraints(
        { start: drag.startRange.start + dt, end: drag.startRange.end + dt },
        'body',
        duration,
      );
    } else {
      // 'start' | 'end': el borde arrastrado va al puntero; el opuesto es ancla.
      range = solveTrimConstraints({ ...range, [drag.mode]: t }, drag.mode, duration);
    }
    render();
  }

  function onUp(e) {
    if (!drag) return;
    drag = null;
    trackEl.releasePointerCapture?.(e.pointerId);
  }

  trackEl.addEventListener('pointerdown', onDown);
  trackEl.addEventListener('pointermove', onMove);
  trackEl.addEventListener('pointerup', onUp);
  trackEl.addEventListener('pointercancel', onUp);
  render();

  return {
    // Re-siembra el rango (re-edición no-destructiva: al reabrir un item ya
    // recortado). Clampa por defensa y respeta el mínimo.
    setRange({ start, end }) {
      range = { start: clamp(start, 0, duration), end: clamp(end, 0, duration) };
      if (range.end < range.start + MIN_TRIM) {
        range.end = Math.min(duration, range.start + MIN_TRIM);
      }
      render();
    },
    // { start, duration } para trimAudio/buildVideoArgs, o null si no hay recorte.
    getTrim() {
      return rangeToTrim(range, duration);
    },
    reset() {
      range = { start: 0, end: duration };
      render();
    },
    destroy() {
      trackEl.removeEventListener('pointerdown', onDown);
      trackEl.removeEventListener('pointermove', onMove);
      trackEl.removeEventListener('pointerup', onUp);
      trackEl.removeEventListener('pointercancel', onUp);
      trackEl.innerHTML = '';
      trackEl.classList.remove('trimtrack');
    },
  };
}
