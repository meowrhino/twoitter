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

import { CSRF_HEADERS } from './state.js';
import { uuid } from './utils.js';
import { compressVideo, compressImage, generateVideoThumb } from './compressor.js';
import { audioPlayerMarkup } from './audio-player.js';

async function uploadBlob(blob, folder) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': blob.type,
      'x-content-type': blob.type,
      'x-folder': folder,
      ...CSRF_HEADERS,
    },
    body: blob,
  });
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

// Sube los blobs ya procesados + (si es vídeo) thumbnail. `kind` puede ser
// 'image' | 'video' | 'audio'; el folder R2 cambia en consecuencia.
async function uploadCompressed(compressed, kind) {
  const folder =
    kind === 'video' ? 'videos' : kind === 'audio' ? 'audios' : 'images';
  const main = await uploadBlob(compressed.blob, folder);
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
// no se re-comprime: opus ya viene óptimo de MediaRecorder, y los formatos
// subidos manualmente (mp3/m4a/ogg) ya están comprimidos lo bastante.
async function compressItem(file, kind, onProgress) {
  if (kind === 'video') {
    const result = await compressVideo(file, onProgress);
    let thumbBlob = null;
    try {
      const t = await generateVideoThumb(file);
      thumbBlob = t.blob;
    } catch (e) {
      console.warn('thumb failed', e);
    }
    return { ...result, thumbBlob };
  }
  if (kind === 'audio') {
    // Pasamos el File directo como blob — uploadBlob lee blob.type, y los
    // tipos que aceptamos en el server ya están en la whitelist de media.ts.
    return { blob: file, width: null, height: null };
  }
  return compressImage(file);
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
  el.innerHTML = `
    ${media}
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
    label.textContent = extra.sizeMB ? `${extra.sizeMB} MB · listo` : 'comprimido';
  } else if (kind === 'uploading') {
    status.classList.add('indeterminate');
    fill.style.width = '';
    label.textContent = 'subiendo a R2…';
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
  const kind = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : null;
  if (!kind) return;

  const localId = uuid();
  const previewUrl = URL.createObjectURL(file);
  const itemEl = createPreviewItem({ localId, previewUrl, kind });
  previewRoot.appendChild(itemEl);

  itemEl.querySelector('.remove').onclick = () => {
    pending.delete(localId);
    itemEl.remove();
    URL.revokeObjectURL(previewUrl);
  };

  const item = {
    file,
    previewUrl,
    kind,
    status: 'compressing',
    compressed: null,
    compressionPromise: null,
    compressionError: null,
  };
  pending.set(localId, item);

  // Lanza compresión async — no la await aquí. El submit la espera.
  // Audio no se re-comprime; aún así pasa por el mismo flujo para reutilizar
  // los estados/overlays de la barra de progreso.
  const initialLabel =
    kind === 'video' ? 'preparando vídeo…'
    : kind === 'audio' ? 'preparando audio…'
    : 'comprimiendo imagen…';
  setItemStatus(itemEl, 'compressing', { label: initialLabel });
  item.compressionPromise = compressItem(file, kind, (p) => {
    if (!pending.has(localId)) return; // el usuario quitó el item
    if (p.phase === 'loading') {
      // 'descargando ffmpeg…' / 'inicializando ffmpeg…' — barra indeterminada
      setItemStatus(itemEl, 'compressing', { label: p.label });
    } else if (p.phase === 'compressing') {
      // percent real desde ffmpeg.on('progress')
      const verb = kind === 'video' ? 'comprimiendo vídeo' : 'comprimiendo';
      setItemStatus(itemEl, 'compressing', { percent: p.percent, label: verb });
    }
  })
    .then((result) => {
      if (!pending.has(localId)) return null;
      item.compressed = result;
      item.status = 'compressed';
      const sizeMB = (result.blob.size / (1024 * 1024)).toFixed(2);
      setItemStatus(itemEl, 'compressed', { sizeMB });
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
      const meta = await uploadCompressed(item.compressed, item.kind);
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
  }
}
