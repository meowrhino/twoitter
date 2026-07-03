// ----- composer principal + reply-inline + paste global -----

import { composerState, POLL_LIMITS } from './state.js';
import { api } from './api.js';
import { isAuthed } from './auth.js';
import { mediaKindOf, toast } from './utils.js';
import { attachFile, uploadPendingFiles, revokePendingUrls } from './media.js';
import { wireRecorderButton } from './recorder.js';
import { enqueueVoiceNotes } from './queue.js';
import { wirePollBlock, collectPollOptions, resetPollBlock } from './composer-poll.js';
import { wireLyricsBlock, collectLyrics, resetLyricsBlock } from './composer-lyrics.js';
import { wireLocation } from './composer-location.js';

// ----- estado interno -----

// Último composer que recibió focus. Si el usuario abre un reply-inline y
// luego pierde el focus (clic fuera, scroll, etc.), seguimos recordando
// cuál era el "activo" para enrutar bien el paste.
let lastFocusedComposer = null;

// ----- cablear un composer ya existente en el DOM -----

// Engancha drop/file-input/submit a un form .composer. El paste se gestiona
// globalmente con setupGlobalPasteHandler y enruta al composer con foco.
// El estado por composer vive en composerState (WeakMap).
export function wireComposer({ form, text, preview, fileInput, recordBtn, pollEl = null, pollBtn = null, lyricsEl = null, lyricsBtn = null, parentId = null, onPosted }) {
  if (!form) return;
  const pending = new Map();
  composerState.set(form, { pending, preview });

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
    if (!t && !hasFiles && !hasPoll && !hasLyrics) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    // Guardamos la etiqueta original ("publicar" o "responder") para
    // restaurarla; mientras tanto el botón muestra el estado de subida.
    const submitLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'publicando…';
    }
    try {
      const media = hasFiles ? await uploadPendingFiles(pending, preview) : [];
      const { location, lat, lng } = loc.getValue();
      const payload = { text: t || null, media, parent_id: parentId, location, lat, lng };
      if (hasPoll) payload.poll = { options: pollOpts };
      if (hasLyrics) payload.lyrics = lyrics;
      const { ok, status, data: post } = await api('/api/posts', {
        method: 'POST',
        body: payload,
      });
      // status 0 = fallo de red (api() no lanza): TypeError, como fetch, para
      // que el catch pueda decidir mandar la nota de voz a la cola offline.
      if (!ok) throw status === 0 ? new TypeError('post failed: red') : new Error('post failed');
      text.value = '';
      revokePendingUrls(pending);
      preview.innerHTML = '';
      pending.clear();
      resetPollBlock(pollEl, pollBtn);
      resetLyricsBlock(lyricsEl, lyricsBtn);
      loc.reset();
      onPosted(post);
    } catch (err) {
      console.error(err);
      // Fallo de RED (TypeError: lo lanza fetch, y uploadBlob/el throw de
      // arriba lo replican) y el post es solo nota(s) de voz, sin encuesta ni
      // letras → a la cola offline: se subirá, publicará y transcribirá sola
      // al volver la conexión (queue.js, flush en app.js).
      const netFail = err instanceof TypeError || !navigator.onLine;
      const { location, lat, lng } = loc.getValue();
      if (
        netFail && hasFiles && !hasPoll && !hasLyrics &&
        (await enqueueVoiceNotes(pending, { text: t || null, parent_id: parentId, location, lat, lng }))
      ) {
        text.value = '';
        revokePendingUrls(pending);
        preview.innerHTML = '';
        pending.clear();
        loc.reset();
        toast('sin conexión — nota guardada, se publicará al volver la red', 'info');
      } else {
        // los items 'ready' conservan su r2_key cacheado: reintentando
        // publicar solo se vuelven a subir los que estaban en 'pending'.
        toast('error al publicar', 'error');
      }
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
