// ----- composer principal + reply-inline + paste global -----

import { CSRF_HEADERS, composerState } from './state.js';
import { isAuthed } from './auth.js';
import { toast } from './utils.js';
import { attachFile, uploadPendingFiles, revokePendingUrls } from './media.js';
import { renderThread } from './render.js';
import { notifyThreadChanged, getThreadRoot } from './rails.js';

// ----- estado interno -----

// Último composer que recibió focus. Si el usuario abre un reply-inline y
// luego pierde el focus (clic fuera, scroll, etc.), seguimos recordando
// cuál era el "activo" para enrutar bien el paste.
let lastFocusedComposer = null;

// ----- cablear un composer ya existente en el DOM -----

// Engancha drop/file-input/submit a un form .composer. El paste se gestiona
// globalmente con setupGlobalPasteHandler y enruta al composer con foco.
// El estado por composer vive en composerState (WeakMap).
export function wireComposer({ form, text, preview, fileInput, parentId = null, onPosted }) {
  if (!form) return;
  const pending = new Map();
  composerState.set(form, { pending, preview });

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview, pending);
    fileInput.value = '';
  });

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
    if (!t && !hasFiles) return;

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const media = hasFiles ? await uploadPendingFiles(pending, preview) : [];
      const res = await fetch('/api/posts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...CSRF_HEADERS },
        body: JSON.stringify({ text: t || null, media, parent_id: parentId }),
      });
      if (!res.ok) throw new Error('post failed');
      const post = await res.json();
      text.value = '';
      revokePendingUrls(pending);
      preview.innerHTML = '';
      pending.clear();
      onPosted(post);
    } catch (err) {
      console.error(err);
      // los items 'ready' conservan su r2_key cacheado: reintentando
      // publicar solo se vuelven a subir los que estaban en 'pending'.
      toast('error al publicar', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// ----- composer inline (reply a un post existente) -----

// Crea un composer en el DOM, lo cablea y devuelve el nodo. El caller
// decide dónde insertarlo. Al postear, inserta la respuesta dentro del
// parentPostEl (creando .thread-replies si hace falta).
export function makeInlineComposer(parentPostEl, parentId) {
  const form = document.createElement('form');
  form.className = 'composer reply-inline';
  form.innerHTML = `
    <textarea placeholder="responder..." rows="2"></textarea>
    <div class="media-preview"></div>
    <div class="composer-foot">
      <label class="file-btn">
        adjuntar
        <input type="file" accept="image/*,video/*" multiple hidden />
      </label>
      <span class="grow"></span>
      <button type="button" class="link-btn cancel">cancelar</button>
      <button type="submit" class="btn-primary">responder</button>
    </div>
  `;
  const text = form.querySelector('textarea');
  const preview = form.querySelector('.media-preview');
  const fileInput = form.querySelector('input[type="file"]');
  form.querySelector('.cancel').onclick = () => {
    const state = composerState.get(form);
    if (state) revokePendingUrls(state.pending);
    form.remove();
  };

  wireComposer({
    form,
    text,
    preview,
    fileInput,
    parentId,
    onPosted: (post) => {
      let nested = parentPostEl.querySelector(':scope > .thread-replies');
      if (!nested) {
        nested = document.createElement('div');
        nested.className = 'thread-replies';
        parentPostEl.appendChild(nested);
      }
      nested.appendChild(renderThread(post));
      notifyThreadChanged({
        parentPost: parentPostEl,
        threadRoot: getThreadRoot(parentPostEl),
        delta: +1,
      });
      form.remove();
    },
  });

  // Foco vía microtask: queremos que un Cmd+V inmediatamente posterior
  // al click en "responder" encuentre el textarea como activeElement.
  queueMicrotask(() => text.focus());
  return form;
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
      if (!file || (!file.type.startsWith('image/') && !file.type.startsWith('video/'))) continue;
      e.preventDefault();
      await attachFile(file, state.preview, state.pending);
      any = true;
    }
    if (any) formEl.querySelector('textarea')?.focus();
  });
}
