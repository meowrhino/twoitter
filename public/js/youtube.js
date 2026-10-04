// youtube: tarjeta con miniatura en vez de iframe (portado de notas8).
// El Worker sirve COEP require-corp en todo (lo exige el SharedArrayBuffer de
// ffmpeg.wasm) y eso BLOQUEA los iframes de youtube; iOS tampoco soporta la
// alternativa credentialless. Así que nada de embed: tarjeta con la miniatura
// (proxy same-origin /yt/<id>.jpg, ver src/index.ts — de paso el navegador no
// habla nunca con Google al leer) y ▸ que abre el vídeo en youtube (pestaña
// nueva; en iPhone, la app).

const YT_RE = /(?:youtube\.com\/(?:watch\?[^\s<]*?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi;

// ids únicos de vídeos de youtube mencionados en un texto, en orden
export function youtubeIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(YT_RE)) ids.add(m[1]);
  return [...ids];
}

// título/autor de cada vídeo, cacheado en memoria: el feed se re-pinta a
// menudo y el oEmbed no cambia (null = ya se preguntó y no hay datos)
const ytMeta = new Map();

// Una tarjeta por cada vídeo de youtube mencionado en `text`, al final de
// `container` (el enlace de texto sigue ahí; la tarjeta es el "verse").
export function appendYoutubeCards(container, text) {
  for (const id of youtubeIds(text)) {
    const a = document.createElement('a');
    a.className = 'yt-card';
    a.href = `https://www.youtube.com/watch?v=${id}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'ver en youtube';
    const frame = document.createElement('span');
    frame.className = 'yt-frame';
    const img = document.createElement('img');
    img.src = `/yt/${id}.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    // sin miniatura (vídeo borrado/privado): la tarjeta sobra, queda el enlace
    img.addEventListener('error', () => a.remove());
    const play = document.createElement('span');
    play.className = 'yt-play';
    play.textContent = '▸';
    frame.append(img, play);
    // pie: «título — canal», lazy vía /yt/<id>/meta (oEmbed proxeado)
    const cap = document.createElement('span');
    cap.className = 'yt-caption';
    const paint = (m) => {
      if (m?.title) cap.textContent = m.author ? `${m.title} — ${m.author}` : m.title;
    };
    if (ytMeta.has(id)) paint(ytMeta.get(id));
    else {
      fetch(`/yt/${id}/meta`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m) => {
          ytMeta.set(id, m);
          paint(m);
        })
        .catch(() => {});
    }
    a.append(frame, cap);
    container.appendChild(a);
  }
}
