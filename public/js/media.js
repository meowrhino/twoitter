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
} from './compressor.js';
import { createPreviewItem, setItemStatus, updatePreviewMedia } from './preview-item.js';
import { toMonoMp3 } from './audio-transcode.js';

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
// original (canvas decoder fiable) en paralelo al output ffmpeg.
// Audio: una nota GRABADA (voiceNote) se recomprime a mono 16 kHz MP3 — Safari
// ignora el bitrate del MediaRecorder y graba a ~189 kbps, así que sin esto
// pesan ~7× de más (ver audio-transcode.js). El audio SUBIDO a mano se deja tal
// cual (podría ser música; además mp3/m4a/ogg ya vienen comprimidos).
// `editParams` (opcional) = { crop?, trim? } en unidades de ORIGEN; el editor de
// medios los produce. Null en el primer pase → comportamiento de siempre.
async function compressItem(file, kind, onProgress, editParams = null, voiceNote = false) {
  if (kind === 'video') {
    // sizeLimit habilita "gana el más pequeño" en compressVideo: si el reencode
    // a WebM queda más pesado que el original (vídeo ya eficiente, sin editar),
    // se sube el original. El mismo MEDIA_LIMITS revalida después en runCompression.
    const result = await compressVideo(file, onProgress, editParams, MEDIA_LIMITS.video);
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
    // Con trim → ffmpeg lo recorta (y ya queda recodificado).
    if (editParams?.trim) return trimAudio(file, editParams.trim, onProgress);
    // Nota grabada sin editar → recomprimir a mono 16 kHz MP3. Fallback al
    // original (toMonoMp3 devuelve null) si decode/encode falla o no compensa.
    if (voiceNote) {
      onProgress?.({ phase: 'loading', label: 'comprimiendo nota…' });
      const mp3 = await toMonoMp3(file);
      if (mp3) return { blob: mp3, width: null, height: null };
    }
    // Audio subido a mano (o recompresión fallida): passthrough (uploadBlob lee
    // blob.type, y los tipos aceptados ya están en la whitelist de media.ts).
    return { blob: file, width: null, height: null };
  }
  return compressImage(file, editParams);
}

// El DOM del item de preview (createPreviewItem), su overlay de estado
// (setItemStatus) y el swap del medio editado (updatePreviewMedia) viven en
// preview-item.js; aquí se importan. canEditKind también se movió allí.

// Adjunta un archivo al composer: guarda el File en pending, lo previsualiza
// y lanza la compresión en background. Nada se sube a R2 hasta el submit.
//
// El estado del item evoluciona: pending → compressing → compressed → uploading → ready.
// La promise de compresión se guarda en `compressionPromise` para que submit
// la pueda esperar si todavía está en marcha.
// `opts.voiceNote` (lo pasa el recorder) marca el item como nota grabada para
// que compressItem la recomprima a mono 16 kHz MP3. Las subidas a mano no lo
// pasan → se dejan tal cual.
export async function attachFile(file, previewRoot, pending, opts = {}) {
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
    voiceNote: !!opts.voiceNote, // nota grabada → recomprimir a mp3 (compressItem)
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
  }, item.editParams, item.voiceNote)
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

// updatePreviewMedia (swap del medio editado en el preview) vive en preview-item.js.

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
