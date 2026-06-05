// ----- compresión + subida + preview local -----
//
// Flujo:
//   attachFile()  → guarda File en pending y lanza compresión async
//   submit        → uploadPendingFiles() espera a la compresión y sube
//                   el blob comprimido + thumbnail a R2
//
// Política "siempre comprimir": vídeo via ffmpeg.wasm (lanza si no hay SAB),
// imagen via canvas WebP. La compresión arranca al adjuntar para aprovechar
// el tiempo que el usuario tarda escribiendo el post.

import { CSRF_HEADERS, MEDIA_LIMITS } from './state.js';
import { mediaKindOf, uuid } from './utils.js';
import {
  compressVideo,
  compressImage,
  generateVideoThumb,
  trimAudio,
  detectCapabilities,
} from './compressor.js';
import { audioPlayerMarkup } from './audio-player.js';

// Subimos vía XHR (no fetch) para poder reportar el progreso real con
// xhr.upload.onprogress — fetch no expone progreso de subida. onProgress
// recibe un ratio 0..1. Replica lo que hacía api(): cookie de sesión
// (same-origin) + CSRF header. Devuelve el JSON del server ({ key, ... }).
function uploadBlob(blob, folder, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', blob.type);
    xhr.setRequestHeader('x-content-type', blob.type);
    xhr.setRequestHeader('x-folder', folder);
    for (const [k, v] of Object.entries(CSRF_HEADERS)) xhr.setRequestHeader(k, v);
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('upload failed: respuesta no-JSON'));
        }
      } else {
        reject(new Error('upload failed: ' + xhr.status));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed: red')));
    xhr.send(blob);
  });
}

// Sube los blobs ya procesados + (si es vídeo) thumbnail. `kind` puede ser
// 'image' | 'video' | 'audio'; el folder R2 cambia en consecuencia.
async function uploadCompressed(compressed, kind, onProgress) {
  const folder =
    kind === 'video' ? 'videos' : kind === 'audio' ? 'audios' : 'images';
  const main = await uploadBlob(compressed.blob, folder, onProgress);
  let thumb_key = null;
  if (kind === 'video' && compressed.thumbBlob) {
    try {
      thumb_key = (await uploadBlob(compressed.thumbBlob, 'thumbs')).key;
    } catch (e) {
      console.warn('thumb upload failed', e);
    }
  }
  return {
    kind,
    r2_key: main.key,
    thumb_key,
    width: compressed.width ?? null,
    height: compressed.height ?? null,
  };
}

// Orquesta compresión + thumb. Para vídeo, el thumb se genera del File
// original (canvas decoder fiable) en paralelo al output ffmpeg. El audio
// no se re-comprime: el recorder ya graba Opus a 24 kbps mono (ver
// recorder.js), y los formatos subidos manualmente (mp3/m4a/ogg) ya están
// comprimidos lo bastante.
// `editParams` (opcional) = { crop?, trim? } en unidades de ORIGEN; el editor de
// medios los produce. Null en el primer pase → comportamiento de siempre.
async function compressItem(file, kind, onProgress, editParams = null) {
  if (kind === 'video') {
    const result = await compressVideo(file, onProgress, editParams);
    let thumbBlob = null;
    try {
      // Poster del clip recortado: arranca en trim.start si hay trim.
      const t = await generateVideoThumb(file, { atTime: editParams?.trim?.start ?? null });
      thumbBlob = t.blob;
    } catch (e) {
      console.warn('thumb failed', e);
    }
    return { ...result, thumbBlob };
  }
  if (kind === 'audio') {
    // Con trim → ffmpeg lo recorta; sin trim, passthrough (uploadBlob lee
    // blob.type, y los tipos aceptados ya están en la whitelist de media.ts).
    if (editParams?.trim) return trimAudio(file, editParams.trim, onProgress);
    return { blob: file, width: null, height: null };
  }
  return compressImage(file, editParams);
}

// DOM puro: construye el item de preview con preview local + × + overlay
// para el estado (barra de progreso + etiqueta). El overlay se crea aquí,
// vacío y sin .visible: setItemStatus lo activa cuando hace falta.
// ¿Se puede editar audio aquí? El trim de audio necesita ffmpeg (SharedArray
// Buffer); sin él no ofrecemos el botón. Try/catch defensivo: detectCapabilities
// toca globals de navegador que pueden no existir (p.ej. en happy-dom de tests).
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

// Adjunta un archivo al composer: guarda el File en pending, lo previsualiza
// y lanza la compresión en background. Nada se sube a R2 hasta el submit.
//
// El estado del item evoluciona: pending → compressing → compressed → uploading → ready.
// La promise de compresión se guarda en `compressionPromise` para que submit
// la pueda esperar si todavía está en marcha.
export async function attachFile(file, previewRoot, pending) {
  const kind = mediaKindOf(file);
  if (!kind) return;

  const localId = uuid();
  const previewUrl = URL.createObjectURL(file);
  const itemEl = createPreviewItem({ localId, previewUrl, kind });
  previewRoot.appendChild(itemEl);

  itemEl.querySelector('.remove').onclick = () => {
    const it = pending.get(localId);
    pending.delete(localId);
    itemEl.remove();
    URL.revokeObjectURL(previewUrl);
    if (it?.editedPreviewUrl) URL.revokeObjectURL(it.editedPreviewUrl);
    // Avisa por si el editor tenía este item abierto (lo escucha editor.js).
    document.dispatchEvent(new CustomEvent('twoitter:item-removed', { detail: { localId } }));
  };

  const item = {
    file,
    previewUrl,
    kind,
    status: 'compressing',
    compressed: null,
    compressionPromise: null,
    compressionError: null,
    editParams: null,       // { crop?, trim? } tras editar; null = sin editar
    editedPreviewUrl: null, // object URL del blob editado mostrado en el preview
  };
  pending.set(localId, item);

  // Lanza compresión async — no la await aquí. El submit la espera. Audio sin
  // editar no se re-comprime, pero pasa por el mismo flujo para reutilizar los
  // estados/overlays. runCompression se comparte con reprocessItem (editar).
  const initialLabel =
    kind === 'video' ? 'preparando vídeo…'
    : kind === 'audio' ? 'preparando audio…'
    : 'comprimiendo imagen…';
  setItemStatus(itemEl, 'compressing', { label: initialLabel });
  item.compressionPromise = runCompression(item, itemEl, localId, pending);
}

// Núcleo de compresión compartido por attachFile (primer pase) y reprocessItem
// (tras editar). Lee item.file/kind/editParams, pinta el overlay de progreso,
// revalida el tamaño contra MEDIA_LIMITS y deja el resultado en item.compressed.
// Devuelve la promise para guardarla en item.compressionPromise.
function runCompression(item, itemEl, localId, pending) {
  const { kind } = item;
  return compressItem(item.file, kind, (p) => {
    if (!pending.has(localId)) return; // el usuario quitó el item
    if (p.phase === 'loading') {
      // 'descargando ffmpeg…' / 'inicializando ffmpeg…' — barra indeterminada
      setItemStatus(itemEl, 'compressing', { label: p.label });
    } else if (p.phase === 'compressing') {
      // percent real desde ffmpeg.on('progress')
      const verb = kind === 'video' ? 'comprimiendo vídeo' : 'comprimiendo';
      setItemStatus(itemEl, 'compressing', { percent: p.percent, label: verb });
    }
  }, item.editParams)
    .then((result) => {
      if (!pending.has(localId)) return null;
      // Validación de tamaño en cliente: si tras comprimir el blob aún supera
      // el tope del server (MEDIA_LIMITS, traído por /api/me), marcamos error
      // YA — sin esperar a que el upload entero falle al final. El server lo
      // revalida igual. uploadPendingFiles aborta el submit si hay un item en
      // error, así que la preview muestra el porqué y el usuario lo quita.
      const limit = MEDIA_LIMITS[kind];
      if (limit && result.blob.size > limit) {
        item.status = 'error';
        const overMB = (result.blob.size / (1024 * 1024)).toFixed(1);
        const maxMB = Math.round(limit / (1024 * 1024));
        const msg = `demasiado grande: ${overMB} MB (máx ${maxMB} MB)`;
        item.compressionError = new Error(msg);
        setItemStatus(itemEl, 'error', { message: msg });
        return null;
      }
      item.compressed = result;
      item.status = 'compressed';
      const sizeMB = (result.blob.size / (1024 * 1024)).toFixed(2);
      // Mostramos el formato resultante (webp/jpeg/png…) además del tamaño:
      // si una imagen sube SIN comprimir es porque el navegador no generó webp
      // (toBlob ignora el tipo y devuelve otro). Ver el formato real en el
      // preview permite diagnosticarlo desde el propio dispositivo.
      const fmt = (result.blob.type || '').split('/')[1] || '?';
      setItemStatus(itemEl, 'compressed', { sizeMB, fmt });
      return result;
    })
    .catch((err) => {
      if (!pending.has(localId)) return null;
      console.error('compression failed', err);
      item.status = 'error';
      item.compressionError = err;
      setItemStatus(itemEl, 'error', { message: err.message || 'error al comprimir' });
      throw err;
    });
}

// Re-procesa un item ya adjunto aplicando parámetros de edición (crop/trim).
// Reutiliza runCompression (mismo overlay + revalidación) y, al terminar, cambia
// el medio mostrado en el preview por el resultado editado. NO-destructivo:
// siempre parte de item.file (el original), nunca del blob ya editado.
export async function reprocessItem(localId, pending, previewRoot, editParams) {
  const item = pending.get(localId);
  if (!item) return null;
  const itemEl = previewRoot.querySelector(`[data-local-id="${CSS.escape(localId)}"]`);

  // Si el primer pase aún comprimía, espera a que asiente: ffmpeg es un
  // singleton serializado y no queremos dos exec pisándose.
  if (item.status === 'compressing' && item.compressionPromise) {
    try { await item.compressionPromise; } catch { /* da igual, re-procesamos */ }
    if (!pending.has(localId)) return null;
  }

  item.editParams = editParams;
  item.compressed = null;
  item.compressionError = null;
  item.status = 'compressing';
  if (itemEl) {
    const label =
      item.kind === 'video' ? 'reaplicando vídeo…'
      : item.kind === 'audio' ? 'recortando audio…'
      : 'recortando…';
    setItemStatus(itemEl, 'compressing', { label });
  }

  item.compressionPromise = runCompression(item, itemEl, localId, pending);
  // Swap del preview al resultado (no bloquea el submit, que espera la promise
  // por su cuenta). El .catch evita un unhandled rejection en esta rama.
  item.compressionPromise
    .then((result) => {
      if (result && pending.has(localId) && itemEl) updatePreviewMedia(itemEl, item, result);
    })
    .catch(() => { /* el overlay de error ya lo pintó runCompression */ });

  return item.compressionPromise;
}

// Cambia el medio mostrado en el preview por el blob ya editado (object URL
// nuevo), revocando el anterior. El File original NO se toca (la re-edición
// parte de él). Para audio intercambia el <audio> dentro del player.
function updatePreviewMedia(itemEl, item, result) {
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

// Sube todos los items 'compressed' a R2 (esperando antes a que termine
// la compresión de cada uno si aún no acabó). Devuelve metadata para
// POST /api/posts. Si alguno falla, los 'ready' conservan r2_key cacheado.
export async function uploadPendingFiles(pending, previewRoot) {
  const media = [];
  for (const [localId, item] of pending.entries()) {
    // Tras cada await, si el usuario pulsó × y borró este item del Map,
    // saltamos a la siguiente iteración. Sin esto, el upload se ejecutaría
    // igualmente y el post saldría con un media que el usuario quitó.
    if (!pending.has(localId)) continue;
    if (item.status === 'ready') {
      media.push(pickMediaFields(item));
      continue;
    }
    const itemEl = previewRoot.querySelector(`[data-local-id="${CSS.escape(localId)}"]`);

    // Esperar a que termine la compresión si todavía no acabó. Si la
    // promise se rejected, esto re-lanza el mismo error.
    if (item.compressionPromise && item.status === 'compressing') {
      try {
        await item.compressionPromise;
      } catch (err) {
        if (!pending.has(localId)) continue; // borrado mientras comprimía
        throw err;
      }
    }
    if (!pending.has(localId)) continue;
    if (item.status === 'error' || !item.compressed) {
      throw item.compressionError || new Error('item sin comprimir');
    }

    if (itemEl) setItemStatus(itemEl, 'uploading');
    try {
      const meta = await uploadCompressed(item.compressed, item.kind, (ratio) => {
        if (itemEl) setItemStatus(itemEl, 'uploading', { percent: Math.round(ratio * 100) });
      });
      if (!pending.has(localId)) continue; // borrado durante el upload
      pending.set(localId, { ...item, ...meta, status: 'ready' });
      if (itemEl) setItemStatus(itemEl, 'ok');
      media.push(pickMediaFields(meta));
    } catch (err) {
      if (!pending.has(localId)) continue;
      if (itemEl) setItemStatus(itemEl, 'error');
      pending.set(localId, { ...item, status: 'error' });
      throw err;
    }
  }
  return media;
}

function pickMediaFields({ kind, r2_key, thumb_key, width, height }) {
  return { kind, r2_key, thumb_key, width, height };
}

// Libera todos los blob URLs creados con createObjectURL para los items
// aún en pending. Sin esto, los blobs quedan en memoria hasta recargar.
export function revokePendingUrls(pending) {
  for (const m of pending.values()) {
    if (m.previewUrl) URL.revokeObjectURL(m.previewUrl);
    if (m.editedPreviewUrl) URL.revokeObjectURL(m.editedPreviewUrl);
  }
}
