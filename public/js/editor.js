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
// F5 implementa el camino de IMAGEN (recorte). Vídeo (trim+crop) y audio (trim)
// se enchufan en openEditor por kind en fases siguientes.

import { composerState } from './state.js';
import { toast } from './utils.js';
import { reprocessItem } from './media.js';
import { computeDisplayBox } from './editor-geom.js';
import { createCropBox } from './editor-cropbox.js';

let editorEl = null;
let prevFocus = null;
let ctx = null; // contexto de la sesión de edición abierta (o null)

function ensureEditor() {
  if (editorEl && editorEl.isConnected) return editorEl;
  if (editorEl) {
    document.body.appendChild(editorEl);
    return editorEl;
  }
  editorEl = document.createElement('div');
  editorEl.className = 'editor';
  editorEl.setAttribute('role', 'dialog');
  editorEl.setAttribute('aria-modal', 'true');
  editorEl.setAttribute('aria-label', 'editar medio');
  editorEl.hidden = true;
  editorEl.innerHTML = `
    <div class="editor-panel">
      <div class="editor-stage"></div>
      <div class="editor-toolbar">
        <button class="editor-reset link-btn" type="button">restablecer</button>
        <span class="grow"></span>
        <button class="editor-cancel link-btn" type="button">cancelar</button>
        <button class="editor-apply btn-primary" type="button">aplicar</button>
      </div>
    </div>
  `;
  document.body.appendChild(editorEl);
  return editorEl;
}

// Coloca el overlay (y por tanto la caja) exactamente sobre el rect de CONTENIDO
// del medio, descontando letterbox. Guarda el displayBox para que applyEdit
// pueda mapear el recorte a px de origen. Reusable en cada resize.
function reflow() {
  if (!ctx) return;
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
    bitmap = await createImageBitmap(base.item.file, { imageOrientation: 'from-image' });
  } catch (_) {
    try {
      bitmap = await createImageBitmap(base.item.file);
    } catch (err) {
      console.error('editor: no se pudo decodificar la imagen', err);
      toast('no se pudo abrir la imagen', 'error');
      return false;
    }
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

async function openEditor(base) {
  ensureEditor();
  const kind = base.item.kind;
  if (kind !== 'image') {
    // Vídeo/audio llegan en F6/F7; de momento, aviso honesto.
    toast('edición de ' + (kind === 'video' ? 'vídeo' : 'audio') + ': próximamente', 'info');
    return;
  }

  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editorEl.hidden = false;
  document.body.classList.add('editor-open');

  const ok = await openImageEditor(base);
  if (!ok) {
    closeEditor();
    return;
  }

  // Observa cambios de tamaño del medio (rotación, resize de ventana). En el
  // preview headless el ResizeObserver no dispara; el resize de ventana sí.
  ctx.ro = new ResizeObserver(() => reflow());
  ctx.ro.observe(ctx.mediaEl);
  window.addEventListener('resize', reflow);

  // Foco al primer control (punto de entrada al modal).
  editorEl.querySelector('.editor-apply')?.focus();
}

// ─── aplicar / restablecer / cerrar ─────────────────────────────

function applyEdit() {
  if (!ctx) return;
  const crop = ctx.kind === 'image' || ctx.kind === 'video'
    ? ctx.cropbox?.getCropSource(ctx.displayBox)
    : null;

  // editParams resultante. Mantén el trim previo si lo hubiera (vídeo/audio, F6+).
  const editParams = {};
  if (crop) editParams.crop = crop;
  if (ctx.item.editParams?.trim) editParams.trim = ctx.item.editParams.trim;

  // No-op: nada que aplicar y nada editado antes → no re-encodear por gusto.
  const hadEdits = !!(ctx.item.editParams && (ctx.item.editParams.crop || ctx.item.editParams.trim));
  const hasEdits = !!(editParams.crop || editParams.trim);
  if (!hasEdits && !hadEdits) {
    closeEditor();
    return;
  }

  reprocessItem(ctx.localId, ctx.pending, ctx.previewRoot, editParams);
  closeEditor();
}

function resetCrop() {
  if (!ctx?.cropbox) return;
  ctx.cropbox.setFraction({ x: 0, y: 0, w: 1, h: 1 });
}

function closeEditor() {
  if (!editorEl) return;
  if (ctx) {
    ctx.ro?.disconnect();
    window.removeEventListener('resize', reflow);
    ctx.cropbox?.destroy();
    // ctx.urls va vacío hoy a propósito: el editor de imagen no crea object URLs
    // propios (pinta sobre un <canvas>). Hook para F6 (vídeo): openVideoEditor
    // empujará aquí los blob URLs del <video> del stage para revocarlos al cerrar.
    for (const u of ctx.urls || []) URL.revokeObjectURL(u);
  }
  const stage = editorEl.querySelector('.editor-stage');
  if (stage) stage.innerHTML = '';
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

// Focus-trap: ciclo de Tab dentro del modal (clon de gallery.js trapTab).
function trapTab(e) {
  const focusables = editorEl.querySelectorAll(
    'button:not([hidden]):not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
  } else if (!editorEl.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

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
    if (e.target.closest('.editor-reset')) { resetCrop(); return; }
    if (e.target === editorEl) closeEditor(); // click en backdrop
  });

  document.addEventListener('keydown', (e) => {
    if (!editorEl || editorEl.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    else if (e.key === 'Tab') trapTab(e);
  });

  document.addEventListener('twoitter:item-removed', onItemRemoved);
}
