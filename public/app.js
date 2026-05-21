// ----- shared state -----
const PAGE = location.pathname.startsWith('/post/') ? 'post' : 'timeline';
const POST_ID = PAGE === 'post' ? parseInt(location.pathname.split('/')[2]) : null;

let IS_AUTHED = false;
let nextCursor = null;
let loading = false;

const SIDEBAR_KEY = 'twoitter_sidebar_hidden';
const CSRF_HEADERS = { 'x-twoitter-csrf': '1' };

// Estado por composer (no se mete en el nodo DOM, así no pollutea el form
// con props ad-hoc). WeakMap permite GC automático: cuando el <form> sale
// del DOM y nadie más lo referencia, su entrada aquí se libera sola.
// shape: { pending: Map<localId, mediaState>, preview: HTMLElement }
const composerState = new WeakMap();

// ----- toast -----

function toast(msg, type = 'info') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ----- helpers -----

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkify(text) {
  const esc = escapeHtml(text);
  let out = esc.replace(/#([\p{L}\p{N}_]+)/gu, (_, t) =>
    `<a class="hashtag" href="/?tag=${encodeURIComponent(t.toLowerCase())}">#${escapeHtml(t)}</a>`,
  );
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (u) => {
    // u is already HTML-escaped; sanity-check protocol via URL parser
    try {
      const parsed = new URL(u.replace(/&amp;/g, '&'));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return u;
    } catch { return u; }
    return `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  });
  return out;
}

// formato europeo: 1032 → "1.032", 1032456 → "1.032.456"
const NUM_FMT = new Intl.NumberFormat('es-ES');
const fmt = (n) => NUM_FMT.format(n);

// siempre en horas, con separador de millares (0h para < 1h)
function hoursAgo(iso) {
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const hours = Math.floor((Date.now() - t) / 3600_000);
  return `${fmt(hours)}h`;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// Ajusta el contador "N resp" del .post pasado, sin recargar.
// delta: +1 al añadir un reply, -1 al borrar uno. El contador se guarda
// en dataset.replyCount (no se parsea del texto, que va con formato es-ES).
function updateReplyCount(postEl, delta) {
  if (!postEl) return;
  const current = parseInt(postEl.dataset.replyCount || '0') || 0;
  const next = Math.max(0, current + delta);
  postEl.dataset.replyCount = String(next);

  const foot = postEl.querySelector(':scope > .post-body > .post-foot');
  if (!foot) return;
  const permalink = foot.querySelector('.permalink');
  let countLink = foot.querySelector('a.resp-count');

  if (next === 0) {
    countLink?.remove();
    return;
  }
  if (countLink) {
    countLink.textContent = `${fmt(next)} resp`;
  } else if (permalink) {
    countLink = document.createElement('a');
    countLink.className = 'resp-count';
    countLink.href = permalink.getAttribute('href');
    countLink.textContent = `${fmt(next)} resp`;
    permalink.after(countLink);
  }
}

// Recarga el sidebar #tags si está visible. Llamar tras crear/borrar
// posts para que los counts y la lista no queden obsoletos.
function refreshHashtags() {
  if (document.body.classList.contains('sidebar-hidden')) return;
  if (!$('#tagList')) return;
  loadHashtags();
}

// Ajusta el bottom del rail vertical (::before) de cada .post para que
// termine al fin de SU PROPIO subtree (último .post descendiente, o el
// propio .post si no tiene descendientes). Así el rail del nivel N
// representa visualmente el alcance de ese post, no del thread completo:
// si #18 tiene un único hijo #20 y un hermano #19 después, el rail de #18
// termina con #20, no se extiende hasta #19.
function extendRails(rootEl) {
  if (!rootEl) return;
  const posts = rootEl.querySelectorAll('.post');
  if (posts.length === 0) return;
  for (const post of posts) {
    // descendientes en orden DOM; el último es el último visualmente
    // (replies se renderizan en created_at ASC, así que DOM = visual).
    const descendants = post.querySelectorAll('.post');
    const last = descendants.length ? descendants[descendants.length - 1] : post;
    const target = last.getBoundingClientRect().bottom;
    const pb = post.getBoundingClientRect().bottom;
    // CSS bottom es relativo al .post: positivo sube, negativo extiende
    // por debajo del .post. queremos rail.bottom (viewport) === target,
    // así que rail.bottom (CSS) = post.bottom - target.
    post.style.setProperty('--rail-bottom', `${pb - target}px`);
  }
  ensureRailObserver(rootEl);
}

// ResizeObserver compartido: cuando un .thread cambia de altura (por
// ejemplo, al cargarse una imagen async), recalcula sus rails sin que
// haga falta un evento explícito.
const _railObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
      for (const e of entries) extendRails(e.target);
    })
  : null;

function ensureRailObserver(threadEl) {
  if (!_railObserver || threadEl._railObserved) return;
  threadEl._railObserved = true;
  _railObserver.observe(threadEl);
}

// devuelve el contenedor lógico del thread para un .post dado:
// - timeline: el .thread ancestro
// - single (replies anidados): el #replies ancestro
// - single (post principal): no aplica (no tiene rail)
function getThreadRoot(postEl) {
  return postEl.closest('.thread') || postEl.closest('#replies');
}

// Recalcula los rails de todos los threads/replies visibles. Útil para
// resize: el contenido reorganiza alturas, los rails quedan desfasados.
function extendAllRails() {
  for (const t of document.querySelectorAll('.thread, #replies')) {
    extendRails(t);
  }
}

// Único punto de entrada para "algo cambió en este thread": actualiza el
// contador del padre, reextiende los rails y refresca el sidebar de tags.
// Antes este bloque se repetía literal en delete + 3 onPosted distintos.
//   parentPost  → ancestro cuyo "N resp" hay que ajustar (null si root nuevo)
//   threadRoot  → .thread o #replies a re-medir (null para skip)
//   delta       → +1 al añadir, -1 al borrar, 0 si solo es reorder
function notifyThreadChanged({ parentPost = null, threadRoot = null, delta = 0 } = {}) {
  if (parentPost && delta) updateReplyCount(parentPost, delta);
  if (threadRoot && threadRoot.isConnected) extendRails(threadRoot);
  refreshHashtags();
}

// ----- auth check & visibility -----

async function checkAuth() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    IS_AUTHED = !!d.authed;
  } catch {
    IS_AUTHED = false;
  }
  applyAuthVisibility();
}

function applyAuthVisibility() {
  for (const el of $$('[data-authed-only]')) el.hidden = !IS_AUTHED;
  for (const el of $$('[data-anon-only]')) el.hidden = IS_AUTHED;
  document.body.classList.toggle('anon', !IS_AUTHED);
  document.body.classList.toggle('authed', IS_AUTHED);
  // sidebar plegado por defecto, abierto solo si el usuario lo pidió
  const shown = IS_AUTHED && localStorage.getItem(SIDEBAR_KEY) === 'open';
  document.body.classList.toggle('sidebar-hidden', !shown);
  const tog = $('#toggleSidebar');
  if (tog) tog.textContent = shown ? 'ocultar #tags' : 'mostrar #tags';
}

// ----- menu -----

function setupMenu() {
  const btn = $('#menuBtn');
  const panel = $('#menuPanel');
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !panel.hidden;
    panel.hidden = open;
    btn.setAttribute('aria-expanded', String(!open));
    btn.classList.toggle('open', !open);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('open');
    }
  });

  const search = $('#searchBox');
  if (search) {
    const initialQ = new URLSearchParams(location.search).get('q');
    if (initialQ) search.value = initialQ;
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = search.value.trim();
        location.href = q ? `/?q=${encodeURIComponent(q)}` : '/';
      }
    });
  }

  const tog = $('#toggleSidebar');
  if (tog) {
    tog.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('sidebar-hidden');
      localStorage.setItem(SIDEBAR_KEY, hidden ? 'closed' : 'open');
      tog.textContent = hidden ? 'mostrar #tags' : 'ocultar #tags';
      if (!hidden) loadHashtags();
    });
  }
}

// ----- upload + thumbnail -----

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

// Lee width/height de una imagen creando una URL temporal propia, así no
// depende de previewUrl externos (que pueden revocarse por separado).
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

// Sube un archivo (imagen o vídeo) y devuelve la metadata completa que el
// backend espera en /api/posts. Lógica pura — no toca DOM, testeable con
// mock de fetch. attachFile() la usa para orquestar la subida.
async function uploadMedia(file) {
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
  return {
    kind: isVideo ? 'video' : 'image',
    r2_key: main.key,
    thumb_key,
    width,
    height,
  };
}

async function generateVideoThumb(file) {
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
    const timer = setTimeout(
      () => finish(reject, new Error('thumb timeout')),
      10_000,
    );
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

// DOM puro: construye el item de preview con preview local + ×. El status
// (subiendo/ok/error) se inserta solo durante el submit (upload-on-submit).
function createPreviewItem({ localId, previewUrl, isImage }) {
  const el = document.createElement('div');
  el.className = 'item';
  el.dataset.localId = localId;
  el.innerHTML = isImage
    ? `<img src="${previewUrl}"><button class="remove" type="button">×</button>`
    : `<video src="${previewUrl}" muted></video><button class="remove" type="button">×</button>`;
  return el;
}

// Inserta o actualiza el indicador de estado en un item del preview.
// 'uploading' lo muestra, 'ok' lo muestra y desvanece a los 800ms, 'error'
// se queda. 'clear' lo elimina.
function setItemStatus(itemEl, kind) {
  let s = itemEl.querySelector('.status');
  if (kind === 'clear') { s?.remove(); return; }
  if (!s) {
    s = document.createElement('span');
    s.className = 'status';
    // antes del botón remove, para que no se solape
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
// previsualiza localmente. NADA se sube a R2 hasta el submit. Esto evita
// archivos huérfanos en R2 si el usuario cancela o cierra la pestaña.
async function attachFile(file, previewRoot, pending) {
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

// Sube todos los items 'pending' a R2 (uno por uno con feedback visual) y
// devuelve el array de metadata listo para POST /api/posts. Si alguno falla
// re-lanza el error y deja los items 'ready' con su metadata cacheada, así
// el usuario puede reintentar sin re-subir lo que ya subió.
async function uploadPendingFiles(pending, previewRoot) {
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

// ----- render -----

// templates (puros, sin side effects ni DOM) -------------------------------

function renderPostMedia(p) {
  if (p.media.length === 0) return '';
  const items = p.media.map((m) => {
    if (m.kind === 'image') {
      return `<div class="item"><img src="/r2/${m.r2_key}" loading="lazy"></div>`;
    }
    const poster = m.thumb_key ? ` poster="/r2/${m.thumb_key}"` : '';
    return `<div class="item"><video src="/r2/${m.r2_key}" controls preload="metadata"${poster}></video></div>`;
  }).join('');
  return `<div class="post-media count-${Math.min(p.media.length, 4)}">${items}</div>`;
}

// Wrapper de "responder/borrar". Existe siempre que haya algún botón; vacío
// si no hay ninguno (anon, single sin auth, etc.). CSS lo posiciona absoluto
// en .post.clickable y en línea en el resto.
function renderPostActions(single) {
  const reply = IS_AUTHED && !single ? '<button class="reply-btn" type="button">responder</button>' : '';
  const del = IS_AUTHED ? '<button class="delete-btn" type="button">borrar</button>' : '';
  if (!reply && !del) return '';
  return `<span class="post-actions">${reply}${del}</span>`;
}

function renderPostFoot(p, single) {
  const respLink = p.reply_count
    ? `<a class="resp-count" href="/post/${p.id}">${fmt(p.reply_count)} resp</a>`
    : '';
  return `
    <div class="post-foot">
      <a href="/post/${p.id}" class="permalink" title="${escapeHtml(p.created_at)}"><span class="post-id">#${p.id}</span> · ${hoursAgo(p.created_at)}</a>
      ${respLink}
      <span class="grow"></span>
      ${renderPostActions(single)}
    </div>
  `;
}

// bindings (encadenan eventos a un .post ya pintado) ----------------------

// click handler en el .post entero (no solo .post-body) — así clicar
// sobre el rail vertical (que es .post::before, fuera del .post-body)
// también navega al permalink, consistente con el hover. el check de
// closest('.post') === postEl evita que clicks en .post descendientes
// se propaguen al ancestro y naveguen al permalink incorrecto.
function bindPostClickToNavigate(postEl, p) {
  postEl.addEventListener('click', (e) => {
    if (e.target.closest('a, button, video, .composer')) return;
    if (e.target.closest('.post') !== postEl) return;
    location.href = `/post/${p.id}`;
  });
  postEl.classList.add('clickable');
}

// toggle del composer inline. si ya hay uno, lo cierra (y revoca sus blob
// URLs via makeInlineComposer.cancel handler).
function bindReplyButton(postEl, p) {
  const reply = postEl.querySelector(':scope > .post-body .reply-btn');
  if (!reply) return;
  reply.onclick = (e) => {
    e.stopPropagation();
    const existing = postEl.querySelector(':scope > .reply-inline');
    if (existing) { existing.remove(); return; }
    const composer = makeInlineComposer(postEl, p.id);
    const nested = postEl.querySelector(':scope > .thread-replies');
    if (nested) postEl.insertBefore(composer, nested);
    else postEl.appendChild(composer);
  };
}

// borra el post + actualiza counter del padre + reextiende rails + refresca tags
function bindDeleteButton(postEl, p, single) {
  const del = postEl.querySelector(':scope > .post-body .delete-btn');
  if (!del) return;
  del.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿borrar este post?')) return;
    // capturar parent + thread root ANTES del DOM removal — closest() no
    // funciona en nodos detached. en single, replies de nivel 1 cuelgan
    // de #replies; su padre lógico es el post principal.
    const parentPost = findLogicalParentPost(postEl);
    const root = getThreadRoot(postEl);
    const res = await fetch(`/api/posts/${p.id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: CSRF_HEADERS,
    });
    if (!res.ok) { toast('error al borrar', 'error'); return; }
    if (single) { location.href = '/'; return; }
    if (postEl.closest('.thread-replies') || postEl.closest('#replies')) {
      postEl.remove();
    } else {
      postEl.closest('.thread')?.remove() || postEl.remove();
    }
    notifyThreadChanged({ parentPost, threadRoot: root, delta: -1 });
  };
}

function findLogicalParentPost(postEl) {
  let parent = postEl.parentElement?.closest('.post');
  if (!parent && postEl.closest('#replies')) {
    parent = document.querySelector('#postContainer > .post');
  }
  return parent;
}

// renderPost: estructura, datos, bindings. Sin lógica de UI inline ya. ------

function renderPost(p, { single = false } = {}) {
  const el = document.createElement('article');
  el.className = 'post';
  el.dataset.id = p.id;
  // se mantiene como source of truth para updateReplyCount tras add/delete
  el.dataset.replyCount = String(p.reply_count || 0);
  el.innerHTML = `
    <div class="post-body">
      <div class="post-text">${linkify(p.text || '')}</div>
      ${renderPostMedia(p)}
      ${renderPostFoot(p, single)}
    </div>
  `;
  if (!single) bindPostClickToNavigate(el, p);
  bindReplyButton(el, p);
  bindDeleteButton(el, p, single);
  return el;
}

// Recursive: renders a post + its nested replies inside the same .post element.
function renderThread(p) {
  const el = renderPost(p);
  if (p.replies && p.replies.length) {
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    for (const child of p.replies) nested.appendChild(renderThread(child));
    el.appendChild(nested);
  }
  return el;
}

// Inline composer that posts a reply to `parentId` and inserts it nested in `parentPostEl`.
function makeInlineComposer(parentPostEl, parentId) {
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

  // foco síncrono — antes era setTimeout(0), pero queremos que un Cmd+V
  // inmediatamente posterior a "responder" encuentre el textarea como
  // activeElement (y como lastFocusedComposer).
  queueMicrotask(() => text.focus());
  return form;
}

// ----- TIMELINE PAGE -----

async function loadTimeline(reset = false) {
  if (loading) return;
  loading = true;
  try {
    const params = new URLSearchParams();
    const tag = new URLSearchParams(location.search).get('tag');
    const q = new URLSearchParams(location.search).get('q');
    if (tag) params.set('tag', tag);
    if (q) params.set('q', q);
    if (!reset && nextCursor) params.set('cursor', nextCursor);

    const res = await fetch('/api/posts?' + params);
    const data = await res.json();
    const timeline = $('#timeline');
    if (reset) timeline.innerHTML = '';
    for (const p of data.posts) {
      const wrap = document.createElement('div');
      wrap.className = 'thread';
      wrap.appendChild(renderThread(p));
      timeline.appendChild(wrap);
    }
    nextCursor = data.nextCursor;
    $('#loadMore').hidden = !nextCursor;
    extendAllRails();
  } catch (err) {
    console.error('loadTimeline failed', err);
    toast('error al cargar timeline', 'error');
  } finally {
    loading = false;
  }
}

async function loadHashtags() {
  try {
    const res = await fetch('/api/hashtags');
    if (!res.ok) throw new Error('hashtags fetch ' + res.status);
    const tags = await res.json();
    const ul = $('#tagList');
    if (!ul) return;
    const currentTag = new URLSearchParams(location.search).get('tag');
    ul.innerHTML = tags
      .map(
        (t) =>
          `<li><a href="/?tag=${encodeURIComponent(t.tag)}"${t.tag === currentTag ? ' class="active"' : ''}>#${escapeHtml(t.tag)}<span class="count">${t.count}</span></a></li>`,
      )
      .join('');
  } catch (err) {
    // sidebar no crítico — log silencioso, sin toast para no molestar
    console.warn('loadHashtags failed', err);
  }
}

function setupFilterBanner() {
  const tag = new URLSearchParams(location.search).get('tag');
  const q = new URLSearchParams(location.search).get('q');
  const b = $('#filterBanner');
  if (!b) return;
  if (tag || q) {
    b.hidden = false;
    b.innerHTML = `<span>filtro: ${tag ? `#${escapeHtml(tag)}` : `"${escapeHtml(q)}"`}</span><a href="/">limpiar</a>`;
  } else {
    b.hidden = true;
  }
}

// Wires up a composer form (timeline OR reply): drop/file-input/submit.
// Paste se gestiona globalmente (setupGlobalPasteHandler) y enruta al
// composer con foco. El estado por composer vive en composerState (WeakMap)
// para no contaminar el nodo DOM con props ad-hoc.
function wireComposer({ form, text, preview, fileInput, parentId = null, onPosted }) {
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
    if (!IS_AUTHED || !e.dataTransfer) return;
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
      // 1) subir archivos (si los hay). bloquea hasta que terminen.
      const media = hasFiles ? await uploadPendingFiles(pending, preview) : [];
      // 2) crear el post con la metadata recién obtenida.
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
      // si la subida falla, los items 'ready' conservan su r2_key cacheado
      // y el usuario puede reintentar pulsando publicar otra vez sin re-subir.
      toast('error al publicar', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// Libera todos los blob URLs creados con URL.createObjectURL para los
// items aún en pending. Sin esto, los blobs quedan en memoria hasta
// recargar la página — significativo con vídeos.
function revokePendingUrls(pending) {
  for (const m of pending.values()) {
    if (m.previewUrl) URL.revokeObjectURL(m.previewUrl);
  }
}

// Tracking del último composer que recibió focus. Si el usuario abre un
// reply-inline y luego pierde el focus (clic fuera, scroll, etc.), seguimos
// recordando que ese era el composer "activo" para enrutar el paste.
let lastFocusedComposer = null;

// Único listener de paste para toda la página: dirige el archivo al
// composer con foco actual, o al último que tuvo foco si ya no lo tiene
// pero sigue en el DOM. Antes había un listener por composer cerrado
// sobre su propio preview, así que pegar dentro de un reply-inline iba
// al composer principal por error.
function setupGlobalPasteHandler() {
  document.addEventListener('focusin', (e) => {
    const c = e.target.closest?.('.composer');
    if (c) lastFocusedComposer = c;
  });
  document.addEventListener('paste', async (e) => {
    if (!IS_AUTHED || !e.clipboardData) return;
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

// debounced resize: re-extiende todos los rails cuando el viewport cambia
// y los heights de los posts pueden haberse modificado (text reflow).
// load: safety net por si imágenes/vídeos cargaban async tras la medida
// inicial; el ResizeObserver del .thread también lo pilla, pero esto se
// dispara aunque el RO no esté disponible.
function setupResizeRailRecalc() {
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(extendAllRails, 100);
  });
  window.addEventListener('load', extendAllRails);
}

function setupTimelineComposer() {
  wireComposer({
    form: $('#composer'),
    text: $('#text'),
    preview: $('#mediaPreview'),
    fileInput: $('#fileInput'),
    parentId: null,
    onPosted: (post) => {
      // wrap in thread + prepend
      const wrap = document.createElement('div');
      wrap.className = 'thread';
      wrap.appendChild(renderThread(post));
      $('#timeline').prepend(wrap);
      notifyThreadChanged({ threadRoot: wrap });
    },
  });
  const lm = $('#loadMore');
  if (lm) lm.addEventListener('click', () => loadTimeline(false));
}

// ----- POST PAGE -----

async function loadSinglePost() {
  let res;
  try {
    res = await fetch(`/api/posts/${POST_ID}`);
  } catch (err) {
    // fallo de red — distinto de 404. damos pista al usuario.
    console.error('loadSinglePost network', err);
    $('#postContainer').innerHTML = '<p class="not-found">error de red al cargar el post</p>';
    toast('error de red', 'error');
    return;
  }
  if (!res.ok) {
    $('#postContainer').innerHTML = '<p class="not-found">post no encontrado</p>';
    return;
  }
  const { post, replies } = await res.json();
  document.title = `twoitter — ${post.text?.slice(0, 40) || 'post'}`;
  $('#postContainer').appendChild(renderPost(post, { single: true }));

  if (replies.length) {
    $('#repliesHeader').hidden = false;
    for (const r of replies) $('#replies').appendChild(renderThread(r));
    extendRails($('#replies'));
  }
}

function setupReplyForm() {
  wireComposer({
    form: $('#replyForm'),
    text: $('#replyText'),
    preview: $('#replyMediaPreview'),
    fileInput: $('#replyFileInput'),
    parentId: POST_ID,
    onPosted: (reply) => {
      $('#repliesHeader').hidden = false;
      $('#replies').appendChild(renderThread(reply));
      notifyThreadChanged({
        parentPost: document.querySelector('#postContainer > .post'),
        threadRoot: $('#replies'),
        delta: +1,
      });
    },
  });
}

// ----- init -----

(async () => {
  await checkAuth();
  setupMenu();
  setupGlobalPasteHandler();
  setupResizeRailRecalc();

  if (PAGE === 'timeline') {
    setupTimelineComposer();
    setupFilterBanner();
    loadTimeline(true);
    if (IS_AUTHED && !document.body.classList.contains('sidebar-hidden')) {
      loadHashtags();
    }
  } else if (PAGE === 'post') {
    await loadSinglePost();
    setupReplyForm();
  }
})();
