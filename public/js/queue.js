// ----- cola offline de notas de voz (IndexedDB) -----
//
// Portado de notas6 (public/js/queue.js). Corre en la página, sin service
// worker: así sobrevive a que iOS evicte el SW.
//
// Flujo: grabas una nota de voz sin conexión (o el submit falla por red) → el
// blob se guarda aquí → al volver la red (evento 'online' o al abrir la app,
// ver app.js) cada nota pendiente se sube, se publica como su propio twoitt y
// se transcribe SOLA.
//
// Diferencia clave con notas6: allí se transcribía por r2_key ANTES de crear
// la nota; aquí el endpoint es POST /api/media/:id/transcribe, que necesita el
// media ya attachado a un post. Por eso el orden es upload → publicar post →
// transcribir. Tras publicar guardamos media_id/post_id en el item: si la
// transcripción falla y se reintenta más tarde, NO se vuelve a publicar el
// post (evita duplicados).

import { api } from './api.js';

const DB_NAME = 'twoitter-queue';
const STORE = 'pending';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}

// meta = { text?, parent_id?, location?, lat?, lng? } — lo que el post
// publicado desde la cola llevará además del audio. El blob debería venir YA
// transcodificado a mp3 (toMonoMp3) cuando fue posible; si no, va el original
// (la whitelist de /api/upload acepta m4a/webm igual, solo pesa más).
export async function enqueue(blob, meta = {}) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) =>
    s.add({
      blob,
      content_type: blob.type,
      text: meta.text || null,
      parent_id: meta.parent_id ?? null,
      location: meta.location ?? null,
      lat: meta.lat ?? null,
      lng: meta.lng ?? null,
      created_at: Date.now(),
    }),
  );
}

// Encola las notas de voz de un composer cuyo submit falló por red. Solo actúa
// si TODOS los items pendientes son notas grabadas (voiceNote): un post mixto
// (imagen + audio…) no se puede trocear sin sorpresas, así que ese cae al
// toast de error normal. Con varias notas, cada una se publicará como su
// propio twoitt; el texto/ubicación van solo con la primera (el parent_id sí
// se conserva en todas: eran respuestas al mismo post).
// Devuelve true si encoló (el caller limpia el composer).
export async function enqueueVoiceNotes(pending, meta) {
  const items = [...pending.values()];
  if (items.length === 0 || !items.every((it) => it.voiceNote)) return false;
  let first = true;
  for (const it of items) {
    // compressed.blob = mp3 mono 16 kHz si la recompresión llegó a correr;
    // fallback al File original si no (p.ej. lamejs no cargó sin red).
    await enqueue(it.compressed?.blob ?? it.file, first ? meta : { parent_id: meta.parent_id });
    first = false;
  }
  return true;
}

export async function pendingCount() {
  const db = await openDb();
  return (await tx(db, 'readonly', (s) => s.count())) ?? 0;
}

async function listAll() {
  const db = await openDb();
  return (await tx(db, 'readonly', (s) => s.getAll())) ?? [];
}

async function remove(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(id));
}

// put() con keyPath existente = update. Muta también el objeto en memoria para
// que un bumpAttempts posterior no pise los campos recién guardados.
async function patch(item, fields) {
  Object.assign(item, fields);
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.put({ ...item }));
}

async function bumpAttempts(item) {
  await patch(item, { attempts: (item.attempts || 0) + 1 });
}

let processing = false;

// Una nota que falla siempre al transcribir (audio que Whisper no puede
// decodificar, una grabación en silencio…) NO puede atascar la cola para
// siempre: tras MAX_ATTEMPTS el post se queda publicado SOLO con el audio —
// no se pierde nada, y el botón «transcribir» sigue disponible en el feed.
const MAX_ATTEMPTS = 5;

// Procesa la cola en orden. Devuelve cuántos posts publicó. Si algo falla
// (p.ej. la red vuelve a caerse a mitad), lo que quede sigue en la cola para
// el siguiente intento — solo borramos del IndexedDB tras publicar (y
// transcribir o agotar intentos).
export async function processQueue(onProgress) {
  if (processing) return 0;
  processing = true;
  let published = 0;
  try {
    const items = await listAll();
    for (const item of items) {
      onProgress?.(`subiendo nota pendiente (${published + 1}/${items.length})…`);
      try {
        let mediaId = item.media_id ?? null;
        if (!mediaId) {
          const ct = item.content_type || 'application/octet-stream';
          const up = await api('/api/upload', {
            method: 'POST',
            body: item.blob,
            headers: { 'content-type': ct, 'x-content-type': ct, 'x-folder': 'audios' },
          });
          if (!up.ok || !up.data?.key) {
            throw new Error(up.data?.error || `upload failed: ${up.status}`);
          }
          const res = await api('/api/posts', {
            method: 'POST',
            body: {
              text: item.text || null,
              media: [{ kind: 'audio', r2_key: up.data.key, thumb_key: null, width: null, height: null }],
              parent_id: item.parent_id ?? null,
              location: item.location ?? null,
              lat: item.lat ?? null,
              lng: item.lng ?? null,
            },
          });
          if (!res.ok) throw new Error(res.data?.error || `post failed: ${res.status}`);
          mediaId = res.data?.media?.find((m) => m.kind === 'audio')?.id ?? null;
          // Persistir YA: a partir de aquí el post existe, y un reintento
          // futuro debe saltar directo a la transcripción.
          await patch(item, { media_id: mediaId, post_id: res.data?.id ?? null });
        }
        if (mediaId) {
          onProgress?.('transcribiendo nota pendiente…');
          const tr = await api(`/api/media/${mediaId}/transcribe`, { method: 'POST' });
          if (!tr.ok) {
            // si aún quedan intentos, reintentamos la transcripción la próxima
            // vez (el post ya está publicado); si no, lo dejamos con el audio
            // a secas y seguimos
            if ((item.attempts || 0) + 1 < MAX_ATTEMPTS) {
              throw new Error(tr.data?.error || `transcribe failed: ${tr.status}`);
            }
          }
        }
        await remove(item.id);
        published++;
      } catch (err) {
        await bumpAttempts(item);
        throw err; // corta el procesado: probablemente la red se cayó otra vez
      }
    }
  } finally {
    processing = false;
  }
  return published;
}
