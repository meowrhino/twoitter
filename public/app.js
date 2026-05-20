// ----- shared state -----
const PAGE = location.pathname.startsWith('/post/') ? 'post' : 'timeline';
const POST_ID = PAGE === 'post' ? parseInt(location.pathname.split('/')[2]) : null;

let IS_AUTHED = false;
let nextCursor = null;
let loading = false;
let knownTags = new Set();

const SIDEBAR_KEY = 'twoitter_sidebar_hidden';
const CSRF_HEADERS = { 'x-twoitter-csrf': '1' };

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

function timeAgo(iso) {
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toISOString().slice(0, 10);
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
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

async function attachFile(file, previewRoot, pending) {
  const localId = uuid();
  const previewUrl = URL.createObjectURL(file);
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return;

  const itemEl = document.createElement('div');
  itemEl.className = 'item';
  itemEl.dataset.localId = localId;
  itemEl.innerHTML = isImage
    ? `<img src="${previewUrl}"><span class="status">subiendo…</span><button class="remove" type="button">×</button>`
    : `<video src="${previewUrl}" muted></video><span class="status">subiendo…</span><button class="remove" type="button">×</button>`;
  previewRoot.appendChild(itemEl);

  itemEl.querySelector('.remove').onclick = () => {
    pending.delete(localId);
    itemEl.remove();
    URL.revokeObjectURL(previewUrl);
  };

  pending.set(localId, { status: 'uploading', previewUrl });

  try {
    const main = await uploadBlob(file, isImage ? 'images' : 'videos');
    let thumb_key = null;
    let width = null;
    let height = null;
    if (isVideo) {
      try {
        const t = await generateVideoThumb(file);
        width = t.width;
        height = t.height;
        const thumbRes = await uploadBlob(t.blob, 'thumbs');
        thumb_key = thumbRes.key;
      } catch (e) {
        console.warn('thumb failed', e);
      }
    } else {
      try {
        const dims = await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = rej;
          img.src = previewUrl;
        });
        width = dims.w;
        height = dims.h;
      } catch {}
    }
    pending.set(localId, {
      kind: isImage ? 'image' : 'video',
      r2_key: main.key,
      thumb_key,
      width,
      height,
      status: 'ready',
      previewUrl,
    });
    itemEl.querySelector('.status').textContent = 'ok';
    setTimeout(() => itemEl.querySelector('.status')?.remove(), 800);
  } catch (e) {
    console.error(e);
    const s = itemEl.querySelector('.status');
    if (s) s.textContent = 'error';
    pending.delete(localId);
  }
}

// ----- render -----

function renderPost(p, { single = false } = {}) {
  const el = document.createElement('article');
  el.className = 'post';
  el.dataset.id = p.id;

  const mediaHtml =
    p.media.length === 0
      ? ''
      : `<div class="post-media count-${Math.min(p.media.length, 4)}">${p.media
          .map((m) => {
            if (m.kind === 'image') {
              return `<div class="item"><img src="/r2/${m.r2_key}" loading="lazy"></div>`;
            }
            return `<div class="item"><video src="/r2/${m.r2_key}" controls preload="metadata"${m.thumb_key ? ` poster="/r2/${m.thumb_key}"` : ''}></video></div>`;
          })
          .join('')}</div>`;

  el.innerHTML = `
    <div class="post-body">
      <div class="post-text">${linkify(p.text || '')}</div>
      ${mediaHtml}
      <div class="post-foot">
        <a href="/post/${p.id}" class="permalink" title="${escapeHtml(p.created_at)}">${timeAgo(p.created_at)}</a>
        ${p.reply_count ? `<a href="/post/${p.id}">${p.reply_count} resp</a>` : ''}
        <span class="grow"></span>
        ${IS_AUTHED ? '<button class="delete-btn" type="button">borrar</button>' : ''}
      </div>
    </div>
  `;

  if (!single) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button, video, .post-media')) return;
      location.href = `/post/${p.id}`;
    });
    el.classList.add('clickable');
  }

  const del = el.querySelector('.delete-btn');
  if (del) {
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('¿borrar este post?')) return;
      const res = await fetch(`/api/posts/${p.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: CSRF_HEADERS,
      });
      if (res.ok) {
        if (single) {
          location.href = '/';
        } else if (el.closest('.thread-replies')) {
          // reply: solo el post, no el thread entero
          el.remove();
        } else {
          // root: borra el thread completo
          el.closest('.thread')?.remove() || el.remove();
        }
      } else {
        toast('error al borrar', 'error');
      }
    };
  }

  return el;
}

// ----- TIMELINE PAGE -----

async function loadTimeline(reset = false) {
  if (loading) return;
  loading = true;
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
    wrap.appendChild(renderPost(p));
    if (p.replies && p.replies.length) {
      const repliesEl = document.createElement('div');
      repliesEl.className = 'thread-replies';
      for (const r of p.replies) repliesEl.appendChild(renderPost(r));
      wrap.appendChild(repliesEl);
    }
    timeline.appendChild(wrap);
  }
  nextCursor = data.nextCursor;
  $('#loadMore').hidden = !nextCursor;
  loading = false;
}

async function loadHashtags() {
  const res = await fetch('/api/hashtags');
  const tags = await res.json();
  knownTags = new Set(tags.map((t) => t.tag));
  const ul = $('#tagList');
  if (!ul) return;
  const currentTag = new URLSearchParams(location.search).get('tag');
  ul.innerHTML = tags
    .map(
      (t) =>
        `<li><a href="/?tag=${encodeURIComponent(t.tag)}"${t.tag === currentTag ? ' class="active"' : ''}>#${escapeHtml(t.tag)}<span class="count">${t.count}</span></a></li>`,
    )
    .join('');
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

// Wires up a composer form (timeline OR reply): paste/drop/file-input/submit.
// Each composer gets its own pending Map so attachments don't leak.
function wireComposer({ form, text, preview, fileInput, parentId = null, onPosted }) {
  if (!form) return;
  const pending = new Map();

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview, pending);
    fileInput.value = '';
  });

  document.addEventListener('paste', async (e) => {
    if (!IS_AUTHED || !e.clipboardData) return;
    let any = false;
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
          e.preventDefault();
          await attachFile(file, preview, pending);
          any = true;
        }
      }
    }
    if (any) text.focus();
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
    const media = [...pending.values()]
      .filter((m) => m.status === 'ready')
      .map(({ kind, r2_key, thumb_key, width, height }) => ({ kind, r2_key, thumb_key, width, height }));
    if (!t && media.length === 0) return;
    if ([...pending.values()].some((m) => m.status === 'uploading')) {
      toast('espera a que terminen de subir los archivos', 'warn');
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...CSRF_HEADERS },
        body: JSON.stringify({ text: t || null, media, parent_id: parentId }),
      });
      if (!res.ok) throw new Error('post failed');
      const post = await res.json();
      text.value = '';
      preview.innerHTML = '';
      pending.clear();
      onPosted(post);
    } catch (err) {
      console.error(err);
      toast('error al publicar', 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
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
      wrap.appendChild(renderPost(post));
      $('#timeline').prepend(wrap);
      maybeRefreshHashtags(post);
    },
  });
  const lm = $('#loadMore');
  if (lm) lm.addEventListener('click', () => loadTimeline(false));
}

// ----- POST PAGE -----

async function loadSinglePost() {
  const res = await fetch(`/api/posts/${POST_ID}`);
  if (!res.ok) {
    $('#postContainer').innerHTML = '<p class="not-found">post no encontrado</p>';
    return;
  }
  const { post, replies } = await res.json();
  document.title = `twoitter — ${post.text?.slice(0, 40) || 'post'}`;
  $('#postContainer').appendChild(renderPost(post, { single: true }));

  if (replies.length) {
    $('#repliesHeader').hidden = false;
    for (const r of replies) $('#replies').appendChild(renderPost(r));
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
      $('#replies').appendChild(renderPost(reply));
    },
  });
}

// Solo recarga el sidebar si el post introdujo un tag nuevo.
function maybeRefreshHashtags(post) {
  const fresh = (post.hashtags || []).filter((t) => !knownTags.has(t));
  if (!fresh.length) return;
  for (const t of fresh) knownTags.add(t);
  loadHashtags();
}

// ----- init -----

(async () => {
  await checkAuth();
  setupMenu();

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
