// ----- composer principal + reply-inline + paste global -----

import { composerState, POLL_LIMITS, TEXT_LIMITS } from './state.js';
import { api } from './api.js';
import { isAuthed } from './auth.js';
import { mediaKindOf, toast } from './utils.js';
import { attachFile, uploadPendingFiles, revokePendingUrls } from './media.js';
import { wireRecorderButton } from './recorder.js';
import { enqueueVoiceNotes } from './queue.js';
import { queuePost, outboxSupported } from './outbox.js';
import { wirePollBlock, collectPollOptions, resetPollBlock } from './composer-poll.js';
import { wireLyricsBlock, collectLyrics, resetLyricsBlock } from './composer-lyrics.js';
import { wireLocation } from './composer-location.js';

// ----- estado interno -----

// Último composer que recibió focus. Si el usuario abre un reply-inline y
// luego pierde el focus (clic fuera, scroll, etc.), seguimos recordando
// cuál era el "activo" para enrutar bien el paste.
let lastFocusedComposer = null;

// ----- borrador persistente (solo composer raíz) -----

// El texto del composer principal se pierde al recargar o dar atrás (p.ej.
// tras compartir un link, o si iOS mata la pestaña). Los reply-inline no lo
// necesitan: son efímeros, viven y mueren con el DOM de su hilo. Solo se
// guarda el texto (media/poll/lyrics no sobreviven a un reload de todos modos).
const DRAFT_KEY = 'twoitter-draft';

function saveDraft(text) {
  try {
    if (text.value.trim()) localStorage.setItem(DRAFT_KEY, text.value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* storage lleno: el borrador vive solo en memoria */ }
}

function restoreDraft(text) {
  let saved = null;
  try {
    saved = localStorage.getItem(DRAFT_KEY);
  } catch { /* no accesible: empezamos de cero */ }
  if (!saved) return;
  text.value = saved;
  toast('borrador recuperado');
}

// ----- cablear un composer ya existente en el DOM -----

// Engancha drop/file-input/submit a un form .composer. El paste se gestiona
// globalmente con setupGlobalPasteHandler y enruta al composer con foco.
// El estado por composer vive en composerState (WeakMap).
export function wireComposer({ form, text, preview, fileInput, recordBtn, pollEl = null, pollBtn = null, lyricsEl = null, lyricsBtn = null, parentId = null, onPosted }) {
  if (!form) return;
  const pending = new Map();
  composerState.set(form, { pending, preview });

  // Borrador solo en el composer raíz (parentId null): index y /compose
  // comparten la misma clave, así que un dictado a medias sobrevive tanto a
  // un reload como a saltar de una página a otra.
  const isRoot = parentId === null;
  if (isRoot) {
    restoreDraft(text);
    text.addEventListener('input', () => saveDraft(text));
  }

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview, pending);
    fileInput.value = '';
  });

  // Botón de grabar: opcional (no todos los browsers soportan MediaRecorder).
  if (recordBtn) {
    wireRecorderButton({ form, button: recordBtn, preview, pending, parentId });
  }

  // Bloque encuesta: opcional. Sólo el composer principal del timeline lo
  // recibe; los reply-inline no llevan encuesta (decisión de diseño: las
  // encuestas nacen como root post, no como respuesta).
  if (pollEl && pollBtn) {
    wirePollBlock(pollEl, pollBtn);
  }

  // Bloque de letras: opcional, mismo criterio que el bloque de encuesta
  // (solo el composer principal del timeline lo recibe).
  if (lyricsEl && lyricsBtn) {
    wireLyricsBlock(lyricsEl, lyricsBtn);
  }

  // Control de ubicación: opcional. Sólo actúa si el form trae el markup
  // (.loc-input / .geo-btn); si no, getValue() devuelve location/lat/lng null.
  const loc = wireLocation(form);

  ['dragenter', 'dragover'].forEach((ev) =>
    form.addEventListener(ev, (e) => { e.preventDefault(); form.classList.add('drag-over'); }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    form.addEventListener(ev, (e) => { e.preventDefault(); form.classList.remove('drag-over'); }),
  );
  form.addEventListener('drop', async (e) => {
    if (!isAuthed() || !e.dataTransfer) return;
    for (const f of e.dataTransfer.files) await attachFile(f, preview, pending);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    const hasFiles = pending.size > 0;
    const pollOpts = collectPollOptions(pollEl);
    const hasPoll = pollOpts !== null;
    const lyrics = collectLyrics(lyricsEl);
    const hasLyrics = lyrics !== null;

    // Validación cliente: si el bloque encuesta está abierto exige >=2
    // opciones rellenas, antes de gastar uploads y red.
    if (hasPoll && pollOpts.length < POLL_LIMITS.min) {
      toast(`la encuesta necesita al menos ${POLL_LIMITS.min} opciones`, 'error');
      return;
    }
    // Aviso antes de gastar red: el texto se pasó del tope (el server lo
    // revalida). Decimos cuánto sobra para que sea fácil recortar.
    if (t.length > TEXT_LIMITS.max) {
      toast(`texto demasiado largo: ${t.length}/${TEXT_LIMITS.max} caracteres (sobran ${t.length - TEXT_LIMITS.max})`, 'error');
      return;
    }
    if (!t && !hasFiles && !hasPoll && !hasLyrics) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    // Guardamos la etiqueta original ("publicar" o "responder") para
    // restaurarla; mientras tanto el botón muestra el estado de subida.
    const submitLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'publicando…';
    }

    // Body de POST /api/posts sin la media (que sale de los uploads o de
    // alguna de las dos colas offline). Se construye antes de subir nada
    // para poder encolarlo tal cual si no hay red.
    const { location, lat, lng } = loc.getValue();
    const payloadBase = { text: t || null, parent_id: parentId, location, lat, lng };
    if (hasPoll) payloadBase.poll = { options: pollOpts };
    if (hasLyrics) payloadBase.lyrics = lyrics;

    const clearForm = () => {
      text.value = '';
      if (isRoot) { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ni estaba guardado */ } }
      revokePendingUrls(pending);
      preview.innerHTML = '';
      pending.clear();
      resetPollBlock(pollEl, pollBtn);
      resetLyricsBlock(lyricsEl, lyricsBtn);
      loc.reset();
    };

    // Guarda el post en la cola offline GENÉRICA (outbox.js) para publicarlo
    // cuando vuelva la red. Espera a que termine la compresión (lo que se
    // guarda son los blobs YA comprimidos); si algún adjunto quedó en error
    // no se puede encolar → false y el submit cae al toast de error normal.
    // Los items 'ready' (ya subidos a R2 en un intento anterior) guardan solo
    // su r2_key — el flush no los re-sube.
    const queueGeneric = async () => {
      if (!outboxSupported()) return false;
      const media = [];
      for (const [localId, item] of pending.entries()) {
        if (item.compressionPromise && item.status === 'compressing') {
          try { await item.compressionPromise; } catch { return false; }
        }
        if (!pending.has(localId)) continue;
        if (item.status === 'ready') {
          media.push({
            kind: item.kind,
            r2_key: item.r2_key,
            thumb_key: item.thumb_key ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
          });
          continue;
        }
        if (!item.compressed) return false;
        media.push({
          kind: item.kind,
          blob: item.compressed.blob,
          thumbBlob: item.compressed.thumbBlob ?? null,
          width: item.compressed.width ?? null,
          height: item.compressed.height ?? null,
        });
      }
      try {
        await queuePost({ payload: payloadBase, media });
      } catch (err) {
        console.error('no se pudo encolar offline', err);
        return false;
      }
      clearForm();
      toast('sin conexión — guardado, se publicará al volver la red 📤');
      return true;
    };

    // Punto único de "vamos offline": si el post es UNA O VARIAS notas de voz
    // solas (sin texto extra que perder, sin encuesta ni letras), preferimos
    // la cola de queue.js — publica Y transcribe sola al volver la red. Para
    // cualquier otra cosa (texto solo, imágenes, vídeo, mezclas) cae a la cola
    // genérica de outbox.js, que no transcribe pero cubre todos los tipos.
    const queueOffline = async () => {
      if (hasFiles && !hasPoll && !hasLyrics) {
        try {
          if (await enqueueVoiceNotes(pending, payloadBase)) {
            clearForm();
            toast('sin conexión — nota guardada, se publicará al volver la red', 'info');
            return true;
          }
        } catch (err) {
          console.error('enqueueVoiceNotes failed', err);
        }
      }
      return queueGeneric();
    };

    try {
      // Offline declarado: ni intentamos subir, directo a la cola.
      if (navigator.onLine === false && (await queueOffline())) return;

      const media = hasFiles ? await uploadPendingFiles(pending, preview) : [];
      const { ok, status, data: post } = await api('/api/posts', {
        method: 'POST',
        body: { ...payloadBase, media },
      });
      if (!ok) {
        // status 0 = la red cayó justo al postear (la media ya subió y los
        // items quedaron 'ready' con su r2_key) → a la cola.
        if (status === 0 && (await queueOffline())) return;
        throw new Error('post failed');
      }
      clearForm();
      onPosted(post);
    } catch (err) {
      // TypeError = la lanza fetch (api.js la reporta como status:0) o el XHR
      // de subida (uploadBlob) ante un fallo de red → a alguna de las colas.
      const netFail = err instanceof TypeError || !navigator.onLine;
      if (netFail && (await queueOffline())) return;
      console.error(err);
      // los items 'ready' conservan su r2_key cacheado: reintentando
      // publicar solo se vuelven a subir los que estaban en 'pending'.
      toast('error al publicar', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    }
  });
}

// ----- paste handler global -----

// Único listener para toda la página. Enruta el archivo pegado al composer
// con foco actual, o al último que tuvo foco si ya no lo tiene pero sigue
// en el DOM. Antes había un listener por composer cerrado sobre su preview,
// y pegar dentro de un reply-inline iba al composer principal por error.
export function setupGlobalPasteHandler() {
  document.addEventListener('focusin', (e) => {
    const c = e.target.closest?.('.composer');
    if (c) lastFocusedComposer = c;
  });
  document.addEventListener('paste', async (e) => {
    if (!isAuthed() || !e.clipboardData) return;
    let formEl = document.activeElement?.closest('.composer');
    if (!formEl && lastFocusedComposer?.isConnected) {
      formEl = lastFocusedComposer;
    }
    const state = formEl && composerState.get(formEl);
    if (!state) return;
    let any = false;
    for (const item of e.clipboardData.items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (!mediaKindOf(file)) continue;
      e.preventDefault();
      await attachFile(file, state.preview, state.pending);
      any = true;
    }
    if (any) formEl.querySelector('textarea')?.focus();
  });
}
