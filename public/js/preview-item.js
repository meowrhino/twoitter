// ----- DOM del item de preview del composer -----
//
// Construcción y estado visual de cada item adjunto en el composer: la
// miniatura con su ×, el botón "recortar" y el overlay de progreso. Extraído de
// media.js, que se queda con el transporte de subida, la orquestación de
// compresión y el pipeline de submit. media.js importa estas funciones.

import { audioPlayerMarkup } from './audio-player.js';
import { detectCapabilities } from './compressor.js';

// ¿Se puede editar este kind? El trim de audio necesita ffmpeg (SharedArrayBuffer);
// sin él no ofrecemos el botón. Try/catch defensivo: detectCapabilities toca
// globals de navegador que pueden no existir (p.ej. en happy-dom de tests).
function canEditKind(kind) {
  if (kind === 'image' || kind === 'video') return true;
  if (kind === 'audio') {
    try {
      return detectCapabilities().ok;
    } catch {
      return false;
    }
  }
  return false;
}

// DOM puro: construye el item de preview con preview local + × + overlay
// para el estado (barra de progreso + etiqueta). El overlay se crea aquí,
// vacío y sin .visible: setItemStatus lo activa cuando hace falta.
export function createPreviewItem({ localId, previewUrl, kind }) {
  const el = document.createElement('div');
  el.className = `item item-${kind}`;
  el.dataset.localId = localId;
  let media;
  if (kind === 'image') {
    media = `<img src="${previewUrl}">`;
  } else if (kind === 'audio') {
    // Reutilizamos el mismo player que el feed (audioPlayerMarkup) para que
    // el usuario pueda escuchar la nota antes de publicar. setupAudioPlayers
    // (MutationObserver global) lo wirea automáticamente al insertarlo.
    media = audioPlayerMarkup({ src: previewUrl });
  } else {
    media = `<video src="${previewUrl}" muted></video>`;
  }
  // Botón "recortar": lo cablea editor.js por delegación global (setupEditor).
  const editBtn = canEditKind(kind)
    ? `<button class="edit" type="button" aria-label="recortar">recortar</button>`
    : '';
  el.innerHTML = `
    ${media}
    ${editBtn}
    <button class="remove" type="button" aria-label="quitar">×</button>
    <div class="status" aria-live="polite">
      <div class="status-bar"><div class="status-bar-fill"></div></div>
      <span class="status-label"></span>
    </div>
  `;
  return el;
}

// Actualiza el overlay de estado de un item. Maneja barra + etiqueta.
// kinds: compressing | compressed | uploading | ok | error | clear.
// extra: { percent, label, sizeMB, message } según el kind.
export function setItemStatus(itemEl, kind, extra = {}) {
  const status = itemEl.querySelector('.status');
  const fill = itemEl.querySelector('.status-bar-fill');
  const label = itemEl.querySelector('.status-label');
  if (!status || !fill || !label) return;

  if (kind === 'clear') {
    status.classList.remove('visible', 'status-err', 'status-ok', 'indeterminate');
    return;
  }

  status.classList.add('visible');
  status.classList.remove('status-err', 'status-ok');

  if (kind === 'compressing') {
    if (extra.percent != null) {
      status.classList.remove('indeterminate');
      fill.style.width = `${extra.percent}%`;
      label.textContent = extra.label
        ? `${extra.label} ${extra.percent}%`
        : `comprimiendo ${extra.percent}%`;
    } else {
      // Sin percent: barra "indeterminada" (CSS anima un sliver)
      status.classList.add('indeterminate');
      fill.style.width = '';
      label.textContent = extra.label || 'preparando…';
    }
  } else if (kind === 'compressed') {
    status.classList.remove('indeterminate');
    status.classList.add('status-ok');
    fill.style.width = '100%';
    // Incluye el formato resultante (p.ej. "1.59 MB · webp") para que se vea de
    // un vistazo si la compresión a webp se aplicó o el navegador la ignoró.
    const tag = extra.fmt ? `${extra.sizeMB} MB · ${extra.fmt}` : `${extra.sizeMB} MB · listo`;
    label.textContent = extra.sizeMB ? tag : 'comprimido';
  } else if (kind === 'uploading') {
    if (extra.percent != null) {
      // % real desde xhr.upload.onprogress → barra determinada.
      status.classList.remove('indeterminate');
      fill.style.width = `${extra.percent}%`;
      label.textContent = `subiendo ${extra.percent}%`;
    } else {
      // Fallback (aún sin progreso / blob diminuto): barra indeterminada.
      status.classList.add('indeterminate');
      fill.style.width = '';
      label.textContent = 'subiendo a R2…';
    }
  } else if (kind === 'ok') {
    // No usamos setTimeout para ocultar: el preview se vacía justo después
    // en composer.js (preview.innerHTML = ''), y el feedback real es el
    // post nuevo apareciendo arriba en el timeline.
    status.classList.remove('indeterminate');
    status.classList.add('status-ok');
    fill.style.width = '100%';
    label.textContent = 'publicado';
  } else if (kind === 'error') {
    status.classList.remove('indeterminate');
    status.classList.add('status-err');
    fill.style.width = '100%';
    label.textContent = extra.message || 'error';
  }
}

// Cambia el medio mostrado en el preview por el blob ya editado (object URL
// nuevo), revocando el anterior. El File original NO se toca (la re-edición
// parte de él). Para audio intercambia el <audio> dentro del player.
export function updatePreviewMedia(itemEl, item, result) {
  if (!result?.blob) return;
  const url = URL.createObjectURL(result.blob);
  const prev = item.editedPreviewUrl;
  item.editedPreviewUrl = url;
  const el =
    item.kind === 'image' ? itemEl.querySelector('img')
    : item.kind === 'video' ? itemEl.querySelector('video')
    : itemEl.querySelector('audio');
  if (el) {
    el.src = url;
    if (item.kind !== 'image') { try { el.load(); } catch (_) {} }
  }
  if (prev) URL.revokeObjectURL(prev);
}
