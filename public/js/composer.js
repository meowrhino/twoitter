// ----- composer principal + reply-inline + paste global -----

import { composerState } from './state.js';
import { api } from './api.js';
import { isAuthed } from './auth.js';
import { toast } from './utils.js';
import { attachFile, uploadPendingFiles, revokePendingUrls } from './media.js';
import { renderThread } from './render.js';
import { notifyThreadChanged, getThreadRoot, refreshActiveRail, lockstepRail } from './rails.js';
import { wireRecorderButton, canRecord } from './recorder.js';

// ----- animación de apertura/cierre del reply-inline -----
//
// El composer inline crece/encoge en altura (0 ↔ natural) + fade, con la MISMA
// curva y duración que el rail amarillo, de modo que ambos se mueven juntos.
// lockstepRail (rails.js) pega el rail a esta animación frame a frame mientras
// dura. height:auto no es animable en CSS, así que medimos la altura natural y
// animamos con la Web Animations API; al terminar, el form vuelve a su CSS
// natural (height auto) y el textarea puede volver a crecer al escribir.
const RAIL_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const COMPOSER_ANIM_MS = 320;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Dos keyframes [colapsado, natural]. Colapsamos también padding y márgenes (no
// sólo height) para que el composer nazca desde ~0px: con box-sizing:border-box,
// height:0 dejaría visible el padding+borde (~30px) y no se leería como "crece
// desde la nada". Leemos el estado natural del computed style en vez de
// hardcodear valores, por si el CSS de .reply-inline cambia.
function composerFrames(form) {
  const cs = getComputedStyle(form);
  const natural = {
    height: `${form.offsetHeight}px`, // border-box completo en reposo
    paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop, marginBottom: cs.marginBottom,
    opacity: 1, overflow: 'hidden',
  };
  const collapsed = {
    height: '0px', paddingTop: '0px', paddingBottom: '0px',
    marginTop: '0px', marginBottom: '0px', opacity: 0, overflow: 'hidden',
  };
  return { collapsed, natural };
}

function animateComposerOpen(form) {
  // Sin animación (reduced-motion): sólo ajustar el rail a la nueva altura
  // (openReplyComposer ya no llama refreshActiveRail — delega aquí).
  if (prefersReducedMotion()) { refreshActiveRail(); return; }
  const { collapsed, natural } = composerFrames(form);
  lockstepRail(COMPOSER_ANIM_MS + 60); // el rail crece pegado al composer
  const anim = form.animate([collapsed, natural], { duration: COMPOSER_ANIM_MS, easing: RAIL_CURVE });
  // Asegura el estado final del rail aunque el lockstep/ResizeObserver no haya
  // corrido (p.ej. pestaña en background, donde WAAPI y RO se pausan).
  const settle = () => refreshActiveRail();
  anim.onfinish = settle;
  anim.oncancel = settle;
}

// Encoge el composer y ejecuta `done` (lógica que puede ser CRÍTICA, p.ej.
// insertar la respuesta enviada). `done` se ejecuta SIEMPRE y SÓLO una vez:
//   - guard `fired` evita doble ejecución (onfinish + fallback a la vez)
//   - fallback setTimeout garantiza que corre aunque la animación nunca termine
//     (en background WAAPI se pausa y onfinish no dispara → sin esto, la
//     respuesta no se insertaría y el composer no se cerraría).
function animateComposerClose(form, done) {
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    form.remove();
    done();
    refreshActiveRail(); // asienta el rail a su altura final ya sin composer
  };
  if (prefersReducedMotion()) { finish(); return; }
  const { collapsed, natural } = composerFrames(form);
  lockstepRail(COMPOSER_ANIM_MS + 60); // el rail encoge pegado al composer
  const anim = form.animate([natural, collapsed], { duration: COMPOSER_ANIM_MS, easing: RAIL_CURVE });
  anim.onfinish = finish;
  anim.oncancel = finish;
  setTimeout(finish, COMPOSER_ANIM_MS + 120);
}

// ----- estado interno -----

// Último composer que recibió focus. Si el usuario abre un reply-inline y
// luego pierde el focus (clic fuera, scroll, etc.), seguimos recordando
// cuál era el "activo" para enrutar bien el paste.
let lastFocusedComposer = null;

// Topes de encuesta. Espejo de POLL_MAX_OPTIONS / POLL_OPTION_MAX_LEN en
// src/index.ts. Si se suben allí, conviene subirlos también aquí (o
// expon erlos vía /api/config en el futuro).
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
const POLL_OPTION_MAX_LEN = 80;

// ----- bloque encuesta en el composer -----

// Devuelve null si el bloque no existe o está cerrado. Si está abierto,
// devuelve el array de opciones no vacías. Lo usa el submit handler:
//   null  → no incluir `poll` en el payload
//   array → enviar como poll.options (el servidor revalida tamaños)
function collectPollOptions(pollEl) {
  if (!pollEl || pollEl.hidden) return null;
  const inputs = pollEl.querySelectorAll('.composer-poll-row input');
  const opts = [];
  for (const inp of inputs) {
    const v = inp.value.trim();
    if (v) opts.push(v);
  }
  return opts;
}

// Crea una fila de input para una opción. El botón × sólo se ofrece
// cuando hay más filas que el mínimo (refresh tras add/remove).
function makePollRow() {
  const row = document.createElement('div');
  row.className = 'composer-poll-row';
  row.innerHTML = `
    <input type="text" maxlength="${POLL_OPTION_MAX_LEN}" placeholder="opción" />
    <button type="button" class="poll-remove" aria-label="quitar opción" hidden>×</button>
  `;
  return row;
}

// Reajusta los × y el botón "+ añadir" tras cada add/remove.
function refreshPollBlock(pollEl) {
  const rows = pollEl.querySelectorAll('.composer-poll-row');
  const removableFrom = POLL_MIN_OPTIONS; // a partir de la 3ª fila se puede quitar
  rows.forEach((r, i) => {
    const x = r.querySelector('.poll-remove');
    if (x) x.hidden = i < removableFrom;
  });
  const add = pollEl.querySelector('.composer-poll-add');
  if (add) add.hidden = rows.length >= POLL_MAX_OPTIONS;
}

// Cierra y resetea el bloque (lo vuelve al estado inicial de 2 inputs
// vacíos). Se llama tras publicar con éxito o al pulsar la ×.
function resetPollBlock(pollEl, pollBtn) {
  if (!pollEl) return;
  const rowsWrap = pollEl.querySelector('.composer-poll-rows');
  if (rowsWrap) rowsWrap.innerHTML = '';
  pollEl.hidden = true;
  if (pollBtn) pollBtn.setAttribute('aria-pressed', 'false');
}

// Inicializa el bloque con 2 filas, cablea ×, "+ añadir", y el toggle.
function wirePollBlock(pollEl, pollBtn) {
  if (!pollEl || !pollBtn) return;
  const rowsWrap = pollEl.querySelector('.composer-poll-rows');
  const addBtn = pollEl.querySelector('.composer-poll-add');
  const closeBtn = pollEl.querySelector('.poll-close');

  function ensureMinRows() {
    while (rowsWrap.children.length < POLL_MIN_OPTIONS) {
      rowsWrap.appendChild(makePollRow());
    }
    refreshPollBlock(pollEl);
  }

  // Delegación: × y validación se gestionan en el wrapper de filas.
  rowsWrap.addEventListener('click', (e) => {
    const rm = e.target.closest?.('.poll-remove');
    if (!rm) return;
    const row = rm.closest('.composer-poll-row');
    if (!row) return;
    if (rowsWrap.children.length <= POLL_MIN_OPTIONS) return;
    row.remove();
    refreshPollBlock(pollEl);
  });

  addBtn.addEventListener('click', () => {
    if (rowsWrap.children.length >= POLL_MAX_OPTIONS) return;
    const row = makePollRow();
    rowsWrap.appendChild(row);
    refreshPollBlock(pollEl);
    row.querySelector('input')?.focus();
  });

  closeBtn?.addEventListener('click', () => {
    resetPollBlock(pollEl, pollBtn);
  });

  pollBtn.addEventListener('click', () => {
    if (pollEl.hidden) {
      ensureMinRows();
      pollEl.hidden = false;
      pollBtn.setAttribute('aria-pressed', 'true');
      pollEl.querySelector('input')?.focus();
    } else {
      // Si hay algo escrito, pedir confirmación de descarte. Si está vacío,
      // cerrar sin más.
      const hasContent = [...pollEl.querySelectorAll('input')].some((i) => i.value.trim());
      if (hasContent && !confirm('¿descartar la encuesta?')) return;
      resetPollBlock(pollEl, pollBtn);
    }
  });
}

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
    if (hasPoll && pollOpts.length < POLL_MIN_OPTIONS) {
      toast(`la encuesta necesita al menos ${POLL_MIN_OPTIONS} opciones`, 'error');
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
          notifyThreadChanged({
            parentPost: parentPostEl,
            threadRoot: getThreadRoot(parentPostEl),
            delta: +1,
          });
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
      const t = file.type;
      if (!t.startsWith('image/') && !t.startsWith('video/') && !t.startsWith('audio/')) continue;
      e.preventDefault();
      await attachFile(file, state.preview, state.pending);
      any = true;
    }
    if (any) formEl.querySelector('textarea')?.focus();
  });
}
