// ----- shared state -----
const PAGE = location.pathname.startsWith('/post/') ? 'post' : 'timeline';
const POST_ID = PAGE === 'post' ? parseInt(location.pathname.split('/')[2]) : null;

// pending media attached to composer (timeline or reply)
const pending = new Map(); // localId -> { kind, r2_key, thumb_key, width, height, status, previewUrl }

let nextCursor = null;
let loading = false;

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
  // hashtags
  let out = esc.replace(/#([\p{L}\p{N}_]+)/gu, (_, t) =>
    `<a class="hashtag" href="/?tag=${encodeURIComponent(t.toLowerCase())}">#${escapeHtml(t)}</a>`,
  );
  // urls
  out = out.replace(/(https?:\/\/[^\s<]+)/g, (u) =>
    `<a href="${u}" target="_blank" rel="noopener">${u}</a>`,
  );
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

// ----- upload + thumbnail -----

async function uploadBlob(blob, folder) {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'content-type': blob.type,
      'x-content-type': blob.type,
      'x-folder': folder,
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
        (b) => {
          URL.revokeObjectURL(v.src);
          if (b) resolve({ blob: b, width: w, height: h });
          else reject(new Error('thumb blob null'));
        },
        'image/jpeg',
        0.8,
      );
    };
    v.onerror = () => reject(new Error('video load error'));
  });
}

async function attachFile(file, previewRoot) {
  const localId = uuid();
  const previewUrl = URL.createObjectURL(file);
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  if (!isImage && !isVideo) return;

  const itemEl = document.createElement('div');
  itemEl.className = 'item';
  itemEl.dataset.localId = localId;
  itemEl.innerHTML = isImage
    ? `<img src="${previewUrl}"><span class="status">subiendo...</span><button class="remove" type="button">×</button>`
    : `<video src="${previewUrl}" muted></video><span class="status">subiendo...</span><button class="remove" type="button">×</button>`;
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
    itemEl.querySelector('.status').textContent = 'error';
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
        <a href="/post/${p.id}" class="permalink">${timeAgo(p.created_at)}</a>
        ${p.reply_count ? `<a href="/post/${p.id}">${p.reply_count} resp</a>` : ''}
        <span class="grow"></span>
        <button class="delete-btn" type="button">borrar</button>
      </div>
    </div>
  `;

  // navigate to permalink when clicking the body, but not on links/buttons/media
  if (!single) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button, video, .post-media')) return;
      location.href = `/post/${p.id}`;
    });
    el.style.cursor = 'pointer';
  }

  el.querySelector('.delete-btn').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm('¿borrar este post?')) return;
    const res = await fetch(`/api/posts/${p.id}`, { method: 'DELETE' });
    if (res.ok) {
      if (single) location.href = '/';
      else el.remove();
    } else {
      alert('error al borrar');
    }
  };

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
  for (const p of data.posts) timeline.appendChild(renderPost(p));
  nextCursor = data.nextCursor;
  $('#loadMore').hidden = !nextCursor;
  loading = false;
}

async function loadHashtags() {
  const res = await fetch('/api/hashtags');
  const tags = await res.json();
  const ul = $('#tagList');
  const currentTag = new URLSearchParams(location.search).get('tag');
  ul.innerHTML = tags
    .map(
      (t) =>
        `<li><a href="/?tag=${encodeURIComponent(t.tag)}"${t.tag === currentTag ? ' style="color:var(--accent)"' : ''}>#${escapeHtml(t.tag)}<span class="count">${t.count}</span></a></li>`,
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

function setupComposer() {
  const form = $('#composer');
  const text = $('#text');
  const preview = $('#mediaPreview');
  const fileInput = $('#fileInput');

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview);
    fileInput.value = '';
  });

  // paste anywhere on the page
  document.addEventListener('paste', async (e) => {
    if (!e.clipboardData) return;
    let attachedAny = false;
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
          e.preventDefault();
          await attachFile(file, preview);
          attachedAny = true;
        }
      }
    }
    if (attachedAny) text.focus();
  });

  // drag & drop
  ['dragenter', 'dragover'].forEach((ev) =>
    form.addEventListener(ev, (e) => {
      e.preventDefault();
      form.classList.add('drag-over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    form.addEventListener(ev, (e) => {
      e.preventDefault();
      form.classList.remove('drag-over');
    }),
  );
  form.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    for (const f of e.dataTransfer.files) await attachFile(f, preview);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    const media = [...pending.values()]
      .filter((m) => m.status === 'ready')
      .map(({ kind, r2_key, thumb_key, width, height }) => ({
        kind,
        r2_key,
        thumb_key,
        width,
        height,
      }));
    if (!t && media.length === 0) return;

    const stillUploading = [...pending.values()].some(
      (m) => m.status === 'uploading',
    );
    if (stillUploading) {
      alert('espera a que terminen de subir los archivos');
      return;
    }

    const btn = $('#btnPost');
    btn.disabled = true;
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: t || null, media }),
      });
      if (!res.ok) throw new Error('post failed');
      const post = await res.json();
      text.value = '';
      preview.innerHTML = '';
      pending.clear();
      // prepend to timeline
      $('#timeline').prepend(renderPost(post));
      loadHashtags();
    } catch (err) {
      console.error(err);
      alert('error al publicar');
    } finally {
      btn.disabled = false;
    }
  });

  $('#loadMore').addEventListener('click', () => loadTimeline(false));

  const search = $('#searchBox');
  const initialQ = new URLSearchParams(location.search).get('q');
  if (initialQ) search.value = initialQ;
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = search.value.trim();
      location.href = q ? `/?q=${encodeURIComponent(q)}` : '/';
    }
  });
}

// ----- POST PAGE -----

async function loadSinglePost() {
  const res = await fetch(`/api/posts/${POST_ID}`);
  if (!res.ok) {
    $('#postContainer').innerHTML = '<p>post no encontrado</p>';
    return;
  }
  const { post, replies } = await res.json();
  document.title = `twoitter — ${post.text?.slice(0, 40) || 'post'}`;
  $('#postContainer').appendChild(renderPost(post, { single: true }));

  $('#replyForm').hidden = false;
  if (replies.length) {
    $('#repliesHeader').hidden = false;
    for (const r of replies) $('#replies').appendChild(renderPost(r));
  }
}

function setupReplyForm() {
  const form = $('#replyForm');
  const text = $('#replyText');
  const preview = $('#replyMediaPreview');
  const fileInput = $('#replyFileInput');

  fileInput.addEventListener('change', async (e) => {
    for (const f of e.target.files) await attachFile(f, preview);
    fileInput.value = '';
  });

  document.addEventListener('paste', async (e) => {
    if (!e.clipboardData) return;
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
          e.preventDefault();
          await attachFile(file, preview);
        }
      }
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = text.value.trim();
    const media = [...pending.values()]
      .filter((m) => m.status === 'ready')
      .map(({ kind, r2_key, thumb_key, width, height }) => ({
        kind,
        r2_key,
        thumb_key,
        width,
        height,
      }));
    if (!t && media.length === 0) return;

    const stillUploading = [...pending.values()].some(
      (m) => m.status === 'uploading',
    );
    if (stillUploading) {
      alert('espera a que terminen de subir los archivos');
      return;
    }

    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: t || null, media, parent_id: POST_ID }),
    });
    if (!res.ok) {
      alert('error al responder');
      return;
    }
    const reply = await res.json();
    text.value = '';
    preview.innerHTML = '';
    pending.clear();
    $('#repliesHeader').hidden = false;
    $('#replies').appendChild(renderPost(reply));
  });
}

// ----- init -----

if (PAGE === 'timeline') {
  setupComposer();
  setupFilterBanner();
  loadTimeline(true);
  loadHashtags();
} else if (PAGE === 'post') {
  loadSinglePost();
  setupReplyForm();
}
