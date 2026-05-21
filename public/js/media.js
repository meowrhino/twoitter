// ----- subida de imágenes/vídeos a R2 + preview local -----

import { CSRF_HEADERS } from './state.js';
import { uuid } from './utils.js';

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

// Lee width/height de una imagen con su propia ObjectURL (revoca al final).
function readImageDims(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function generateVideoThumb(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(file);
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(v.src);
      fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error('thumb timeout')), 10_000);
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 1) / 4);
    };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const w = v.videoWidth || 640;
      const h = v.videoHeight || 360;
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      c.toBlob(
        (b) => finish(b ? resolve : reject, b ? { blob: b, width: w, height: h } : new Error('thumb blob null')),
        'image/jpeg',
        0.8,
      );
    };
    v.onerror = () => finish(reject, new Error('video load error'));
  });
}

// Lógica pura: sube y devuelve la metadata que espera /api/posts.
// Sin DOM → testeable con mock de fetch.
export async function uploadMedia(file) {
  const isVideo = file.type.startsWith('video/');
  const main = await uploadBlob(file, isVideo ? 'videos' : 'images');
  let thumb_key = null;
  let width = null;
  let height = null;
  if (isVideo) {
    try {
      const t = await generateVideoThumb(file);
      width = t.width;
      height = t.height;
      thumb_key = (await uploadBlob(t.blob, 'thumbs')).key;
    } catch (e) {
      console.warn('thumb failed', e);
    }
  } else {
    try {
      const dims = await readImageDims(file);
      width = dims.w;
      height = dims.h;
    } catch {}
  }
  return { kind: isVideo ? 'video' : 'image', r2_key: main.key, thumb_key, width, height };
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
export function setItemStatus(itemEl, kind) {
  let s = itemEl.querySelector('.status');
  if (kind === 'clear') { s?.remove(); return; }
  if (!s) {
    s = document.createElement('span');
    s.className = 'status';
    const remove = itemEl.querySelector('.remove');
    if (remove) itemEl.insertBefore(s, remove);
    else itemEl.appendChild(s);
  }
  if (kind === 'uploading') s.textContent = 'subiendo…';
  else if (kind === 'ok') {
    s.textContent = 'ok';
    setTimeout(() => s.remove(), 800);
  } else if (kind === 'error') s.textContent = 'error';
}

// Adjunta un archivo al composer: SOLO guarda el File en pending y lo
// previsualiza. NADA se sube a R2 hasta el submit (uploadPendingFiles).
// Así, si el usuario cancela o cierra, no quedan archivos huérfanos en R2.
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
  pending.set(localId, {
    file,
    previewUrl,
    kind: isImage ? 'image' : 'video',
    status: 'pending', // sube al hacer submit
  });
}

// Sube todos los items 'pending' a R2 y devuelve el array de metadata listo
// para POST /api/posts. Si alguno falla, re-lanza el error pero deja los
// 'ready' con su metadata cacheada: el usuario reintenta sin re-subir.
export async function uploadPendingFiles(pending, previewRoot) {
  const media = [];
  for (const [localId, item] of pending.entries()) {
    if (item.status === 'ready') {
      media.push(pickMediaFields(item));
      continue;
    }
    const itemEl = previewRoot.querySelector(`[data-local-id="${CSS.escape(localId)}"]`);
    if (itemEl) setItemStatus(itemEl, 'uploading');
    try {
      const meta = await uploadMedia(item.file);
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
