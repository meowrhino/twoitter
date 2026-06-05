// ----- composer principal + reply-inline + paste global -----

import { composerState, POLL_LIMITS } from './state.js';
import { api } from './api.js';
import { isAuthed } from './auth.js';
import { mediaKindOf, toast } from './utils.js';
import { attachFile, uploadPendingFiles, revokePendingUrls } from './media.js';
import { renderThread } from './render.js';
import { notifyThreadChanged, getThreadRoot, refreshActiveRail } from './rails.js';
import { wireRecorderButton, canRecord } from './recorder.js';
import { animateComposerOpen, animateComposerClose } from './composer-anim.js';
import { wirePollBlock, collectPollOptions, resetPollBlock } from './composer-poll.js';

// ----- estado interno -----

// Último composer que recibió focus. Si el usuario abre un reply-inline y
// luego pierde el focus (clic fuera, scroll, etc.), seguimos recordando
// cuál era el "activo" para enrutar bien el paste.
let lastFocusedComposer = null;

// ----- cablear un composer ya existente en el DOM -----

// Engancha drop/file-input/submit a un form .composer. El paste se gestiona
// globalmente con setupGlobalPasteHandler y enruta al composer con foco.
// El estado por composer vive en composerState (WeakMap).
export function wireComposer({ form, text, preview, fileInput, recordBtn, pollEl = null, pollBtn = null, parentId = null, onPosted }) {
  if (!form) return;
  const pending = new Map();
  composerState.set(form, { pending, preview });

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview, pending);
    fileInput.value = '';
  });

  // Botón de grabar: opcional (no todos los browsers soportan MediaRecorder).
  if (recordBtn) {
    wireRecorderButton({ form, button: recordBtn, preview, pending });
  }

  // Bloque encuesta: opcional. Sólo el composer principal del timeline lo
  // recibe; los reply-inline no llevan encuesta (decisión de diseño: las
  // encuestas nacen como root post, no como respuesta).
  if (pollEl && pollBtn) {
    wirePollBlock(pollEl, pollBtn);
  }

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

    // Validación cliente: si el bloque encuesta está abierto exige >=2
    // opciones rellenas, antes de gastar uploads y red.
    if (hasPoll && pollOpts.length < POLL_LIMITS.min) {
      toast(`la encuesta necesita al menos ${POLL_LIMITS.min} opciones`, 'error');
      return;
    }
    if (!t && !hasFiles && !hasPoll) return;

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
      const payload = { text: t || null, media, parent_id: parentId };
      if (hasPoll) payload.poll = { options: pollOpts };
      const { ok, data: post } = await api('/api/posts', {
        method: 'POST',
        body: payload,
      });
      if (!ok) throw new Error('post failed');
      text.value = '';
      revokePendingUrls(pending);
      preview.innerHTML = '';
      pending.clear();
      resetPollBlock(pollEl, pollBtn);
      onPosted(post);
    } catch (err) {
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

// ----- composer inline (reply a un post existente) -----

// Crea un composer en el DOM, lo cablea y devuelve el nodo. El caller
// decide dónde insertarlo. Al postear, inserta la respuesta dentro del
// parentPostEl (creando .thread-replies si hace falta).
export function makeInlineComposer(parentPostEl, parentId) {
  const form = document.createElement('form');
  form.className = 'composer reply-inline';
  // El botón "grabar" sólo se inserta si el navegador soporta MediaRecorder —
  // así no aparece un botón muerto en Safari iOS antiguos o similares.
  const recHtml = canRecord()
    ? `<button type="button" class="rec-btn" aria-label="grabar nota de voz">grabar</button>`
    : '';
  form.innerHTML = `
    <textarea placeholder="responder..." rows="2"></textarea>
    <div class="media-preview"></div>
    <div class="composer-foot">
      <label class="file-btn">
        adjuntar
        <input type="file" accept="image/*,video/*,audio/*" multiple hidden />
      </label>
      ${recHtml}
      <span class="grow"></span>
      <button type="button" class="link-btn cancel">cancelar</button>
      <button type="submit" class="btn-primary">responder</button>
    </div>
  `;
  const text = form.querySelector('textarea');
  const preview = form.querySelector('.media-preview');
  const fileInput = form.querySelector('input[type="file"]');
  const recordBtn = form.querySelector('.rec-btn');
  form.querySelector('.cancel').onclick = () => {
    const state = composerState.get(form);
    if (state) revokePendingUrls(state.pending);
    // Encoge el composer (en lockstep con el rail) y, al terminar, lo quita.
    // refreshActiveRail asienta el rail a su altura final ya sin composer.
    animateComposerClose(form, () => {
      form.remove();
      refreshActiveRail();
    });
  };

  wireComposer({
    form,
    text,
    preview,
    fileInput,
    recordBtn,
    parentId,
    onPosted: (post) => {
      let nested = parentPostEl.querySelector(':scope > .thread-replies');
      if (!nested) {
        nested = document.createElement('div');
        nested.className = 'thread-replies';
        // .post-actions vive como ÚLTIMO hijo del root del thread (asRoot=true
        // en renderThread). Hay que insertar .thread-replies ANTES de la barra
        // para mantener el orden DOM body → thread-replies → post-actions;
        // si no, el primer reply mete la barra en medio del thread.
        const actions = parentPostEl.querySelector(':scope > .post-actions');
        if (actions) parentPostEl.insertBefore(nested, actions);
        else parentPostEl.appendChild(nested);
      }
      // renderThread filtra ocultos, pero un post recién creado por el
      // usuario nunca lo estará — el guard es defensivo, no se espera null.
      // asRoot:false → el nuevo reply hereda la barra de acciones del
      // thread root existente, no lleva una propia.
      // Encoge el composer (simétrico a la apertura) y, al terminar, inserta
      // la respuesta y notifica el cambio. Secuencial: el composer se recoge y
      // luego aparece el reply, en vez de saltar de uno a otro.
      // animateComposerClose ya hace form.remove() en su finish() — no lo
      // repetimos aquí.
      animateComposerClose(form, () => {
        const el = renderThread(post, { asRoot: false });
        // Guard isConnected: si el usuario borró el .post padre durante la
        // ventana de animación (~320-440ms), `nested` queda detached y el reply
        // se insertaría en un nodo fuera del DOM (creado en la API pero perdido
        // en la UI). Si pasó, no insertamos ni notificamos: el reply existe en
        // el server y aparecerá al recargar.
        if (el && nested.isConnected) {
          nested.appendChild(el);
          // Expandir el subárbol del root para que la nueva reply se vea
          // in-situ (el BLOQUE arranca colapsado) y dejar el caret del toggle
          // en estado expandido. updateReplyCount (vía notifyThreadChanged)
          // ajusta el conteo del .resp-toggle/.resp-count del padre directo.
          const rootPost = getThreadRoot(parentPostEl)?.querySelector(':scope > .post');
          const rootNested = rootPost?.querySelector(':scope > .thread-replies');
          if (rootNested) {
            rootNested.classList.remove('replies-collapsed');
            rootPost
              .querySelector(':scope > .post-body > .post-foot > .resp-toggle')
              ?.setAttribute('aria-expanded', 'true');
          }
          notifyThreadChanged({
            parentPost: parentPostEl,
            threadRoot: getThreadRoot(parentPostEl),
            delta: +1,
          });
        }
        // TL plana: la reply también es un ítem propio arriba de la TL (con su
        // header "↓ en respuesta a"), tal como aparecería al recargar. Es
        // independiente del anidado de arriba: aunque el padre se haya borrado
        // durante la animación, el ítem suelto sigue siendo válido.
        const timeline = document.getElementById('timeline');
        if (timeline) {
          const topEl = renderThread(post); // asRoot:true → muestra reply-context
          if (topEl) {
            const wrap = document.createElement('div');
            wrap.className = 'thread';
            wrap.appendChild(topEl);
            timeline.prepend(wrap);
            notifyThreadChanged({ threadRoot: wrap });
          }
        }
      });
    },
  });

  // Foco vía microtask: queremos que un Cmd+V inmediatamente posterior
  // al click en "responder" encuentre el textarea como activeElement.
  // En el mismo microtask animamos la apertura: para entonces openReplyComposer
  // ya insertó el form en el DOM, así que scrollHeight mide su altura natural.
  queueMicrotask(() => {
    animateComposerOpen(form);
    text.focus();
  });
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
      if (!file) continue;
      if (!mediaKindOf(file)) continue;
      e.preventDefault();
      await attachFile(file, state.preview, state.pending);
      any = true;
    }
    if (any) formEl.querySelector('textarea')?.focus();
  });
}
