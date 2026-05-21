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

// Sube los blobs ya comprimidos + (si es vídeo) thumbnail.
async function uploadCompressed(compressed, isVideo) {
  const folder = isVideo ? 'videos' : 'images';
  const main = await uploadBlob(compressed.blob, folder);
  let thumb_key = null;
  if (isVideo && compressed.thumbBlob) {
    try {
      thumb_key = (await uploadBlob(compressed.thumbBlob, 'thumbs')).key;
    } catch (e) {
      console.warn('thumb upload failed', e);
    }
  }
  return {
    kind: isVideo ? 'video' : 'image',
    r2_key: main.key,
    thumb_key,
    width: compressed.width ?? null,
    height: compressed.height ?? null,
  };
}

// Orquesta compresión + thumb. Para vídeo, el thumb se genera del File
// original (canvas decoder fiable) en paralelo al output ffmpeg.
async function compressItem(file, isVideo, onProgress) {
  if (isVideo) {
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
  return compressImage(file);
}

// DOM puro: construye el item de preview con preview local + ×.
export function createPreviewItem({ localId, previewUrl, isImage }) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.localId = localId;
  el.innerHTML = isImage
    ? `<img src="${previewUrl}"><button class="remove" type="button">×</button>`
    : `<video src="${previewUrl}" muted></video><button class="remove" type="button">×</button>`;
  return el;
}

// Inserta o actualiza el indicador de estado de un item del preview.
// Estados: compressing-N, compressed-MB, uploading, ok (autodesvanece), error.
export function setItemStatus(itemEl, kind, extra) {
  let s = itemEl.querySelector('.status');
  if (kind === 'clear') { s?.remove(); return; }
  if (!s) {
    s = document.createElement('span');
    s.className = 'status';
    const remove = itemEl.querySelector('.remove');
    if (remove) itemEl.insertBefore(s, remove);
    else itemEl.appendChild(s);
  }
  s.classList.remove('status-err');
  if (kind === 'compressing') {
    // extra: { percent, label } — percent puede ser null durante "loading"
    if (extra?.percent != null) s.textContent = `comprimiendo ${extra.percent}%`;
    else s.textContent = extra?.label || 'preparando…';
  } else if (kind === 'compressed') {
    // extra: { sizeMB } — mostramos el peso final como confirmación
    s.textContent = extra?.sizeMB ? `${extra.sizeMB} MB` : 'listo';
  } else if (kind === 'uploading') {
    s.textContent = 'subiendo…';
  } else if (kind === 'ok') {
    s.textContent = 'ok';
    setTimeout(() => s.remove(), 800);
  } else if (kind === 'error') {
    s.textContent = extra?.message || 'error';
    s.classList.add('status-err');
  }
}

// Adjunta un archivo al composer: guarda el File en pending, lo previsualiza
// y lanza la compresión en background. Nada se sube a R2 hasta el submit.
//
// El estado del item evoluciona: pending → compressing → compressed → uploading → ready.
// La promise de compresión se guarda en `compressionPromise` para que submit
// la pueda esperar si todavía está en marcha.
export async function attachFile(file, previewRoot, pending) {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return;

  const localId = uuid();
  const previewUrl = URL.createObjectURL(file);
  const itemEl = createPreviewItem({ localId, previewUrl, isImage });
  previewRoot.appendChild(itemEl);

  itemEl.querySelector('.remove').onclick = () => {
    pending.delete(localId);
    itemEl.remove();
    URL.revokeObjectURL(previewUrl);
  };

  const item = {
    file,
    previewUrl,
    kind: isImage ? 'image' : 'video',
    status: 'compressing',
    compressed: null,
    compressionPromise: null,
    compressionError: null,
  };
  pending.set(localId, item);

  // Lanza compresión async — no la await aquí. El submit la espera.
  setItemStatus(itemEl, 'compressing', { label: isVideo ? 'preparando…' : 'comprimiendo…' });
  item.compressionPromise = compressItem(file, isVideo, (p) => {
    if (!pending.has(localId)) return; // el usuario quitó el item
    if (p.phase === 'loading') {
      setItemStatus(itemEl, 'compressing', { label: p.label });
    } else if (p.phase === 'compressing') {
      setItemStatus(itemEl, 'compressing', { percent: p.percent, label: p.label });
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
        throw err;
      }
    }
    if (item.status === 'error' || !item.compressed) {
      throw item.compressionError || new Error('item sin comprimir');
    }

    if (itemEl) setItemStatus(itemEl, 'uploading');
    try {
      const isVideo = item.kind === 'video';
      const meta = await uploadCompressed(item.compressed, isVideo);
      pending.set(localId, { ...item, ...meta, status: 'ready' });
      if (itemEl) setItemStatus(itemEl, 'ok');
      media.push(pickMediaFields(meta));
    } catch (err) {
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
