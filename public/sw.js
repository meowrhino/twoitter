// Service worker de twoitter: que la app ABRA sin conexión.
//
// Portado del de notas6 con una diferencia deliberada de estrategia:
//   - notas6: shell cache-first con precache versionado (rápido, pero cada
//     deploy exige subir SW_VERSION o los clientes ven el shell viejo).
//   - twoitter: NETWORK-FIRST con fallback a caché. Twoitter despliega a cada
//     push a main (Workers Builds), así que online siempre se sirve lo fresco
//     y la caché se refresca sola con cada fetch que sale bien; offline se
//     sirve la última copia buena. Cero disciplina de versiones.
//   - /api/* y /r2/*: red SIEMPRE, ni se tocan (nada de cachear datos
//     privados; el feed vive en el server y las colas offline en IndexedDB,
//     gestionadas por la página: queue.js para notas de voz sueltas — sube,
//     publica y transcribe sola —, outbox.js para el resto de posts
//     (texto/imágenes/vídeo/encuesta/letras, sin transcripción automática).
//
// El precache del install existe solo para que el shell COMPLETO esté
// disponible offline aunque no hayas visitado todas las rutas (p.ej.
// lame.min.js, que solo se descarga al grabar la primera nota — y es justo
// lo que permite transcodificar a mp3 estando sin red).
//
// OJO iOS: Safari evicta service workers agresivamente (ya lo vimos con
// coi-serviceworker). Por eso el SW es SOLO mejora progresiva: la app
// funciona idéntica sin él, y la cola offline no depende de él para nada.
//
// COOP/COEP: los sirve el Worker en cada respuesta; las respuestas cacheadas
// conservan sus cabeceras, así que servir desde caché mantiene el aislamiento
// (necesario para el SharedArrayBuffer de ffmpeg.wasm).

const SW_VERSION = 'twoitter-v1';

const SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/compose.html',
  '/places.html',
  '/aviso-legal.html',
  '/style.css',
  '/manifest.json',
  '/app.js',
  '/compose.js',
  '/places.js',
  '/lame.min.js',
  '/ffmpeg.js',
  '/814.ffmpeg.js',
  '/icon-192.png',
  '/icon-512.png',
  '/js/api.js',
  '/js/audio-player.js',
  '/js/audio-transcode.js',
  '/js/auth.js',
  '/js/composer-anim.js',
  '/js/composer-location.js',
  '/js/composer-lyrics.js',
  '/js/composer-poll.js',
  '/js/composer-repeatable.js',
  '/js/composer.js',
  '/js/compressor-image.js',
  '/js/compressor-video.js',
  '/js/compressor.js',
  '/js/editor-cropbox.js',
  '/js/editor-geom.js',
  '/js/editor-trimtrack.js',
  '/js/editor.js',
  '/js/gallery-core.js',
  '/js/gallery.js',
  '/js/hashtags.js',
  '/js/hidden.js',
  '/js/inline-composer.js',
  '/js/lightbox.js',
  '/js/media.js',
  '/js/menu.js',
  '/js/modal.js',
  '/js/outbox.js',
  '/js/pages.js',
  '/js/post-actions.js',
  '/js/preview-item.js',
  '/js/queue.js',
  '/js/rails.js',
  '/js/recorder.js',
  '/js/render-lyrics.js',
  '/js/render-poll.js',
  '/js/render.js',
  '/js/state.js',
  '/js/utils.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SW_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r2/')) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // refrescar la caché con cada respuesta buena (network-first): así el
        // shell cacheado siempre es el del último deploy que llegaste a ver
        if (res.ok) {
          const copy = res.clone();
          caches.open(SW_VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        // sin red: última copia buena; para navegaciones, el index como
        // respaldo final (la SPA resuelve la ruta en cliente)
        const hit = await caches.match(e.request);
        if (hit) return hit;
        if (e.request.mode === 'navigate') {
          const index = await caches.match('/index.html');
          if (index) return index;
        }
        return Response.error();
      }),
  );
});
