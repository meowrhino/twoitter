// ----- modal del editor de medios (singleton, lazy) -----
//
// Clona el patrón del lightbox (gallery.js): un único nodo .editor creado a
// demanda, role=dialog + aria-modal, focus-trap, Esc, click en backdrop,
// body.editor-open. Se cablea con setupEditor() (delegación global) en app.js.
//
// El "stage" muestra el medio + un overlay con la caja de recorte (editor-
// cropbox.js, que razona en su propio espacio; aquí lo colocamos sobre el rect
// de contenido descontando el letterbox vía computeDisplayBox). Al "aplicar",
// recogemos los parámetros de edición y llamamos reprocessItem (media.js), que
// re-comprime desde el File original y cambia el preview.
//
// openEditor despacha por kind: IMAGEN → recorte espacial (caja sobre un canvas);
// VÍDEO → recorte temporal (trim, pista de tiempo) Y espacial (caja, activable con
// el botón "recortar zona" para no tapar los controles nativos); AUDIO → solo trim.
// El medio de vídeo/audio se muestra con controles nativos (play manual, sin
// autoplay) para previsualizar/scrub.

import { composerState } from './state.js';
import { toast } from './utils.js';
import { reprocessItem } from './media.js';
import { decodeOrientedBitmap } from './compressor-image.js';
import { computeDisplayBox } from './editor-geom.js';
import { createCropBox } from './editor-cropbox.js';
import { ensureModal, trapTab } from './modal.js';
import { createTrimTrack } from './editor-trimtrack.js';

let editorEl = null;
let prevFocus = null;
let ctx = null; // contexto de la sesión de edición abierta (o null)

function ensureEditor() {
  editorEl = ensureModal(editorEl, {
    className: 'editor',
    label: 'editar medio',
    html: `
    <div class="editor-panel">
      <div class="editor-stage"></div>
      <div class="editor-trim"></div>
      <div class="editor-toolbar">
        <button class="editor-crop-toggle link-btn" type="button" aria-pressed="false" hidden>recortar zona</button>
        <button class="editor-reset link-btn" type="button">restablecer</button>
        <span class="grow"></span>
        <button class="editor-cancel link-btn" type="button">cancelar</button>
        <button class="editor-apply btn-primary" type="button">aplicar</button>
      </div>
    </div>
  `,
  });
  return editorEl;
}

// Coloca el overlay (y por tanto la caja) exactamente sobre el rect de CONTENIDO
// del medio, descontando letterbox. Guarda el displayBox para que applyEdit
// pueda mapear el recorte a px de origen. Reusable en cada resize.
function reflow() {
  if (!ctx || !ctx.overlay) return; // audio no tiene caja de recorte
  const stage = editorEl.querySelector('.editor-stage');
  const stageRect = stage.getBoundingClientRect();
  const elemRect = ctx.mediaEl.getBoundingClientRect();
  const box = computeDisplayBox(
    { left: elemRect.left, top: elemRect.top, width: elemRect.width, height: elemRect.height },
    ctx.srcW,
    ctx.srcH,
  );
  ctx.overlay.style.left = `${box.left - stageRect.left}px`;
  ctx.overlay.style.top = `${box.top - stageRect.top}px`;
  ctx.overlay.style.width = `${box.width}px`;
  ctx.overlay.style.height = `${box.height}px`;
  ctx.displayBox = box;
  ctx.cropbox?.setBox({ width: box.width, height: box.height });
}

// ─── apertura por tipo ──────────────────────────────────────────

async function openImageEditor(base) {
  let bitmap;
  try {
    bitmap = await decodeOrientedBitmap(base.item.file);
  } catch (err) {
    console.error('editor: no se pudo decodificar la imagen', err);
    toast('no se pudo abrir la imagen', 'error');
    return false;
  }
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // Canvas como medio del stage: MISMO decode ('from-image') que usará el
  // compresor → la caja vive en idéntico espacio de píxeles, sin corrección de
  // orientación. El canvas escala por CSS (max-width/height) preservando aspect.
  const canvas = document.createElement('canvas');
  canvas.className = 'editor-media';
  canvas.width = srcW;
  canvas.height = srcH;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const stage = editorEl.querySelector('.editor-stage');
  stage.appendChild(canvas);
  const overlay = document.createElement('div');
  overlay.className = 'cropbox-overlay';
  stage.appendChild(overlay);
  const cropbox = createCropBox(overlay);

  ctx = { ...base, kind: 'image', srcW, srcH, mediaEl: canvas, overlay, cropbox, displayBox: null };

  // Re-semilla del recorte previo (re-edición no-destructiva: se ve, pero al
  // aplicar se re-deriva del original).
  if (base.item.editParams?.crop) {
    const c = base.item.editParams.crop;
    cropbox.setFraction({ x: c.sx / srcW, y: c.sy / srcH, w: c.sw / srcW, h: c.sh / srcH });
  }

  // Layout: tras un frame el canvas ya tiene tamaño pintado.
  requestAnimationFrame(reflow);
  return true;
}

// Lee la duración (s) de un <audio>/<video> ya con su src. Algunos webm de
// MediaRecorder reportan duration=Infinity hasta hacer un seek al final; forzamos
// el cálculo saltando a un tiempo enorme, esperando a que se vuelva finita y
// volviendo a 0. Rechaza por timeout/error.
function readMediaDuration(el) {
  return new Promise((resolve, reject) => {
    const ok = (d) => { cleanup(); try { el.currentTime = 0; } catch {} resolve(d); };
    const fail = () => { cleanup(); reject(new Error('no se pudo leer la duración')); };
    const timer = setTimeout(fail, 10_000);
    const onDur = () => { if (Number.isFinite(el.duration) && el.duration > 0) ok(el.duration); };
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener('durationchange', onDur);
      el.removeEventListener('error', fail);
    }
    el.addEventListener('durationchange', onDur);
    el.addEventListener('error', fail, { once: true });
    const probe = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) { ok(el.duration); return; }
      try { el.currentTime = 1e7; } catch {} // fuerza el recálculo de duration
    };
    if (el.readyState >= 1) probe();
    else el.addEventListener('loadedmetadata', probe, { once: true });
  });
}

// Sesión de trim (vídeo o audio): mete el medio en el stage con controles nativos
// (play manual, SIN autoplay), lee la duración y crea la pista de recorte.
async function openTrimEditor(base, kind, mediaHtml) {
  const url = URL.createObjectURL(base.item.file);
  const stage = editorEl.querySelector('.editor-stage');
  stage.innerHTML = mediaHtml(url);
  const mediaEl = stage.querySelector(kind === 'video' ? 'video' : 'audio');
  let duration;
  try {
    duration = await readMediaDuration(mediaEl);
  } catch (err) {
    console.error('editor: no se pudo leer la duración', err);
    toast('no se pudo abrir el ' + (kind === 'video' ? 'vídeo' : 'audio'), 'error');
    URL.revokeObjectURL(url);
    return false;
  }
  const trimEl = editorEl.querySelector('.editor-trim');
  const trimtrack = createTrimTrack(trimEl, { duration });
  // Re-semilla del recorte previo (re-edición no-destructiva).
  const prev = base.item.editParams?.trim;
  if (prev) trimtrack.setRange({ start: prev.start, end: prev.start + prev.duration });
  ctx = { ...base, kind, mediaEl, trimtrack, urls: [url] };

  // VÍDEO: además del trim, recorte espacial (zona). El vídeo conserva sus
  // controles nativos (scrub/preview del trim); la caja de recorte vive en un
  // overlay que arranca INACTIVO (el botón "recortar zona" lo activa) para no
  // tapar esos controles. srcW/srcH ya están disponibles (readMediaDuration
  // esperó a los metadatos). AUDIO no lleva caja.
  if (kind === 'video') {
    const srcW = mediaEl.videoWidth;
    const srcH = mediaEl.videoHeight;
    if (srcW > 0 && srcH > 0) {
      stage.classList.add('crop-video'); // CSS: overlay inactivo hasta "recortar zona"
      const overlay = document.createElement('div');
      overlay.className = 'cropbox-overlay';
      stage.appendChild(overlay);
      const cropbox = createCropBox(overlay);
      ctx.srcW = srcW;
      ctx.srcH = srcH;
      ctx.overlay = overlay;
      ctx.cropbox = cropbox;
      ctx.displayBox = null;
      // Re-semilla del recorte espacial previo.
      if (base.item.editParams?.crop) {
        const c = base.item.editParams.crop;
        cropbox.setFraction({ x: c.sx / srcW, y: c.sy / srcH, w: c.sw / srcW, h: c.sh / srcH });
      }
      requestAnimationFrame(reflow);
    }
  }
  return true;
}

function openVideoEditor(base) {
  return openTrimEditor(base, 'video', (url) =>
    `<video class="editor-media" src="${url}" controls playsinline preload="auto"></video>`);
}

function openAudioEditor(base) {
  return openTrimEditor(base, 'audio', (url) =>
    `<audio src="${url}" controls preload="auto"></audio>`);
}

async function openEditor(base) {
  ensureEditor();
  const kind = base.item.kind;
  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // Preparar el medio ANTES de revelar el modal: si tardara o fallara (decode de
  // imagen / lectura de duración) no parpadea un modal vacío.
  let ok = false;
  if (kind === 'image') ok = await openImageEditor(base);
  else if (kind === 'video') ok = await openVideoEditor(base);
  else if (kind === 'audio') ok = await openAudioEditor(base);
  else { toast('no se puede editar este medio', 'info'); return; }
  if (!ok) {
    closeEditor();
    return;
  }
  editorEl.hidden = false;
  document.body.classList.add('editor-open');

  // Imagen y vídeo anclan la caja de recorte al rect de contenido (letterbox) →
  // necesitan ResizeObserver + resize. La pista de trim es % y no requiere reflow.
  if (ctx.overlay) {
    ctx.ro = new ResizeObserver(() => reflow());
    ctx.ro.observe(ctx.mediaEl);
    window.addEventListener('resize', reflow);
  }

  // El botón "recortar zona" solo aplica al vídeo (su caja arranca inactiva).
  const cropToggle = editorEl.querySelector('.editor-crop-toggle');
  if (cropToggle) {
    cropToggle.hidden = !(kind === 'video' && ctx.cropbox);
    cropToggle.setAttribute('aria-pressed', 'false');
  }

  // Foco al primer control (punto de entrada al modal).
  editorEl.querySelector('.editor-apply')?.focus();
}

// ─── aplicar / restablecer / cerrar ─────────────────────────────

function applyEdit() {
  if (!ctx) return;
  // Crop espacial (caja): imagen siempre; vídeo si tiene caja. Trim temporal
  // (pista): vídeo y audio. El vídeo puede llevar AMBOS a la vez.
  const crop = (ctx.kind === 'image' || ctx.kind === 'video') && ctx.cropbox && ctx.displayBox
    ? ctx.cropbox.getCropSource(ctx.displayBox)
    : null;
  const trim = (ctx.kind === 'video' || ctx.kind === 'audio') ? ctx.trimtrack?.getTrim() : null;

  const editParams = {};
  if (crop) editParams.crop = crop;
  if (trim) editParams.trim = trim;

  // No-op: nada nuevo y nada editado antes → no re-encodear por gusto.
  const hadEdits = !!(ctx.item.editParams && (ctx.item.editParams.crop || ctx.item.editParams.trim));
  const hasEdits = !!(editParams.crop || editParams.trim);
  if (!hasEdits && !hadEdits) {
    closeEditor();
    return;
  }

  reprocessItem(ctx.localId, ctx.pending, ctx.previewRoot, editParams);
  closeEditor();
}

function resetEdits() {
  if (!ctx) return;
  ctx.cropbox?.setFraction({ x: 0, y: 0, w: 1, h: 1 }); // imagen: caja a frame completo
  ctx.trimtrack?.reset();                                // vídeo/audio: rango completo
}

function closeEditor() {
  if (!editorEl) return;
  if (ctx) {
    ctx.ro?.disconnect();
    window.removeEventListener('resize', reflow);
    ctx.cropbox?.destroy();
    ctx.trimtrack?.destroy();
    // Revoca los object URLs del medio (vídeo/audio empujan aquí el suyo; el
    // editor de imagen pinta sobre canvas y no crea ninguno).
    for (const u of ctx.urls || []) URL.revokeObjectURL(u);
  }
  const stage = editorEl.querySelector('.editor-stage');
  if (stage) {
    stage.innerHTML = '';
    stage.classList.remove('crop-video', 'crop-on'); // estado del toggle de recorte
  }
  const cropToggle = editorEl.querySelector('.editor-crop-toggle');
  if (cropToggle) { cropToggle.hidden = true; cropToggle.setAttribute('aria-pressed', 'false'); }
  const trimEl = editorEl.querySelector('.editor-trim');
  if (trimEl) trimEl.innerHTML = '';
  editorEl.hidden = true;
  document.body.classList.remove('editor-open');
  const focusBack = ctx?.triggerEl;
  ctx = null;
  // Devuelve el foco al botón "recortar" que abrió el modal (o al disparador).
  if (focusBack && focusBack.isConnected) {
    try { focusBack.focus(); } catch (_) {}
  } else if (prevFocus && prevFocus.isConnected) {
    try { prevFocus.focus(); } catch (_) {}
  }
  prevFocus = null;
}

// Si el item que se está editando se elimina (× en el preview), cierra el modal.
function onItemRemoved(e) {
  if (ctx && e.detail?.localId === ctx.localId) closeEditor();
}

// El focus-trap (trapTab) vive en modal.js; se invoca desde el keydown de abajo.
// El editor no añade selectores extra (no hay <video controls> en el modal).

// ─── wiring global (idempotente) ────────────────────────────────

let wired = false;
export function setupEditor() {
  if (wired) return;
  wired = true;

  document.addEventListener('click', (e) => {
    // Abrir: botón "recortar" de un item del composer.
    const editBtn = e.target.closest('.media-preview .item .edit');
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      const itemEl = editBtn.closest('.item');
      const form = editBtn.closest('.composer');
      const localId = itemEl?.dataset.localId;
      const state = form && composerState.get(form);
      if (!state || !localId) return;
      const item = state.pending.get(localId);
      if (!item) return;
      openEditor({ item, localId, pending: state.pending, previewRoot: state.preview, triggerEl: editBtn, urls: [] });
      return;
    }
    // Controles del modal.
    if (!editorEl || editorEl.hidden) return;
    if (e.target.closest('.editor-cancel')) { closeEditor(); return; }
    if (e.target.closest('.editor-apply')) { applyEdit(); return; }
    if (e.target.closest('.editor-reset')) { resetEdits(); return; }
    // "recortar zona" (solo vídeo): activa/desactiva el overlay de la caja. Al
    // activar, pausa el vídeo para cropear sobre un frame fijo.
    const cropToggle = e.target.closest('.editor-crop-toggle');
    if (cropToggle) {
      const stage = editorEl.querySelector('.editor-stage');
      const on = stage.classList.toggle('crop-on');
      cropToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) { try { ctx?.mediaEl?.pause(); } catch {} reflow(); }
      return;
    }
    if (e.target === editorEl) closeEditor(); // click en backdrop
  });

  document.addEventListener('keydown', (e) => {
    if (!editorEl || editorEl.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Tab') trapTab(editorEl, e);
  });

  document.addEventListener('twoitter:item-removed', onItemRemoved);
}
