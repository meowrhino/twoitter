// ----- cola offline de publicaciones (outbox) -----
//
// Cuando publicar falla por falta de red (o ya estamos offline al darle a
// "publicar"), el post entero — texto + blobs YA comprimidos + encuesta/
// letras/ubicación — se guarda en IndexedDB y se reintenta:
//   - al volver la conexión (evento 'online')
//   - al arrancar la app (setupOutbox hace un flush inicial)
//   - al tocar el chip "📤 N por publicar"
//
// iOS Safari no soporta Background Sync, así que el reintento vive en la
// página (no en el service worker): si cierras la app antes de recuperar
// red, se publica en la siguiente apertura.
//
// Reglas del flush (publishEntry):
//   - FIFO por created_at → se conserva la cronología de lo escrito
//   - error de red → paramos y TODO queda en la cola (seguimos offline)
//   - 401/403 → paramos sin descartar (sesión caducada: hay que loguearse)
//   - otro 4xx → descartamos SOLO ese post (el server lo rechazó;
//     reintentarlo no lo va a arreglar) y avisamos con un toast
//   - tras subir cada blob, su r2_key se guarda en la entrada (checkpoint):
//     si el flush se corta a medias, el reintento no re-sube lo ya subido
//     (ni deja huérfanos en R2)

import { api } from './api.js';
import { uploadCompressed } from './media.js';
import { toast, uuid } from './utils.js';

const DB_NAME = 'twoitter-outbox';
const STORE = 'posts';

// Topes de la cola. iOS evicta el almacenamiento de PWAs con quotas modestas,
// y las notas de voz de iPhone pesan ~7× lo esperado (Safari ignora el
// bitrate del MediaRecorder), así que mejor quedarse cortos que perder todo.
const MAX_ITEMS = 30;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

export function outboxSupported() {
  return typeof indexedDB !== 'undefined';
}

// ----- IndexedDB: helpers mínimos (una store, sin índices) -----

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Ejecuta una operación sobre la store y espera a que la transacción asiente.
// mode: 'readonly' | 'readwrite'. fn recibe la store y devuelve el IDBRequest
// cuyo .result queremos (o null si no interesa el resultado).
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

const idbAll = () => withStore('readonly', (s) => s.getAll()).then((r) => r || []);
const idbPut = (entry) => withStore('readwrite', (s) => s.put(entry));
const idbDelete = (id) => withStore('readwrite', (s) => s.delete(id));

// Bytes que ocupa una entrada: solo los blobs aún sin subir (los media que ya
// tienen r2_key son metadata pequeña).
function entrySize(entry) {
  return (entry.media || []).reduce(
    (sum, m) => sum + (m.blob?.size || 0) + (m.thumbBlob?.size || 0),
    0,
  );
}

// ----- encolar -----

// entry.payload: body de POST /api/posts SIN media ({text, parent_id, location,
// lat, lng, poll?, lyrics?}). entry.media: por item, O BIEN blobs pendientes
// ({kind, blob, thumbBlob?, width, height}) O BIEN metadata ya subida
// ({kind, r2_key, thumb_key, width, height} — items 'ready' del composer).
// Lanza si la cola está llena; el caller decide qué contar al usuario.
export async function queuePost({ payload, media }) {
  const entries = await idbAll();
  if (entries.length >= MAX_ITEMS) {
    throw new Error(`la cola offline está llena (${MAX_ITEMS} posts pendientes)`);
  }
  // seq (no created_at) decide el orden FIFO del flush: Date.now() tiene
  // resolución de 1ms y dos posts encolados en el mismo tick (doble tap,
  // tests) empatarían, dejando el orden a merced de cómo IDB devuelva las
  // claves (uuid → esencialmente aleatorio). seq parte del máximo ya
  // persistido, así que es monótono también entre sesiones/recargas.
  const seq = entries.reduce((max, e) => Math.max(max, e.seq ?? 0), 0) + 1;
  const entry = { id: uuid(), seq, created_at: Date.now(), payload, media };
  const totalBytes = entries.reduce((s, e) => s + entrySize(e), 0);
  if (totalBytes + entrySize(entry) > MAX_TOTAL_BYTES) {
    throw new Error('la cola offline no tiene sitio (demasiados MB pendientes)');
  }
  await idbPut(entry);
  await refreshChip();
  return entry;
}

export async function outboxCount() {
  return (await idbAll()).length;
}

// ----- publicar lo pendiente -----

// Callback global de "se publicaron N pendientes" — lo fija setupOutbox según
// la página (la TL recarga el timeline; /compose solo toastea). Así el chip
// puede disparar un flush sin que cada caller re-pase el callback.
let onPublishedCb = null;

let flushing = false;

// Intenta publicar toda la cola en orden. Devuelve { published, remaining }.
// uploadFn/postFn son inyectables para los tests; en producción no se pasan.
export async function flushOutbox({ onPublished, uploadFn, postFn } = {}) {
  if (flushing || !outboxSupported()) return { published: 0, remaining: null };
  flushing = true;
  try {
    const entries = (await idbAll()).sort((a, b) => a.seq - b.seq);
    let published = 0;
    for (const entry of entries) {
      const outcome = await publishEntry(entry, uploadFn, postFn);
      if (outcome === 'published') published++;
      else if (outcome === 'stop') break;
      // 'dropped' → seguimos con la siguiente
    }
    const remaining = await refreshChip();
    if (published > 0) (onPublished || onPublishedCb)?.(published);
    return { published, remaining };
  } finally {
    flushing = false;
  }
}

// El uploadBlob de media.js rechaza con Error('upload failed: <status>') si el
// server respondió, o 'upload failed: red' si no hubo respuesta. Extraemos el
// status para decidir si el fallo es definitivo (4xx) o reintentable.
function uploadErrorStatus(err) {
  const m = /^upload failed: (\d+)$/.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

async function publishEntry(entry, uploadFn = uploadCompressed, postFn = null) {
  // 1. subir los blobs que aún no tienen r2_key
  for (let i = 0; i < entry.media.length; i++) {
    const m = entry.media[i];
    if (m.r2_key) continue;
    let meta;
    try {
      meta = await uploadFn(
        {
          blob: m.blob,
          thumbBlob: m.thumbBlob ?? null,
          width: m.width ?? null,
          height: m.height ?? null,
        },
        m.kind,
      );
    } catch (err) {
      const status = uploadErrorStatus(err);
      if (status && status !== 401 && status !== 403 && status < 500) {
        // rechazo definitivo (p.ej. 413 demasiado grande): descartar el post
        await idbDelete(entry.id);
        toast('un post pendiente fue rechazado al subir su adjunto', 'error');
        return 'dropped';
      }
      return 'stop'; // sin red / sin sesión / 5xx → reintentar más tarde
    }
    entry.media[i] = meta;
    await idbPut(entry); // checkpoint (ver cabecera del módulo)
  }

  // 2. crear el post con la media ya subida
  const { ok, status } = postFn
    ? await postFn(entry.payload, entry.media)
    : await api('/api/posts', {
        method: 'POST',
        body: { ...entry.payload, media: entry.media },
      });
  if (ok) {
    await idbDelete(entry.id);
    return 'published';
  }
  if (status === 0 || status === 401 || status === 403 || status >= 500) return 'stop';
  await idbDelete(entry.id);
  toast('un post pendiente fue rechazado por el servidor', 'error');
  return 'dropped';
}

// ----- chip "N por publicar" -----

// Botón fijo que aparece cuando hay cola. Tocarlo reintenta el flush a mano
// (útil si el evento 'online' no saltó, p.ej. red que va y viene en iOS).
async function refreshChip() {
  let n = 0;
  try {
    n = await outboxCount();
  } catch {
    return 0;
  }
  let chip = document.getElementById('outboxChip');
  if (n === 0) {
    chip?.remove();
    return 0;
  }
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'outboxChip';
    chip.type = 'button';
    chip.className = 'outbox-chip';
    chip.addEventListener('click', () => {
      flushOutbox().catch(() => {});
    });
    document.body.appendChild(chip);
  }
  chip.textContent = `📤 ${n} por publicar`;
  return n;
}

// ----- arranque -----

// Llamar una vez por página (app.js / compose.js). Pinta el chip si quedó
// cola de una sesión anterior, reintenta ya (por si volvimos con red) y se
// suscribe al evento 'online' para publicar en cuanto vuelva la conexión.
export function setupOutbox({ onPublished } = {}) {
  if (!outboxSupported()) return;
  onPublishedCb = onPublished || null;
  window.addEventListener('online', () => {
    flushOutbox().catch(() => {});
  });
  flushOutbox().catch(() => {
    refreshChip().catch(() => {});
  });
}
