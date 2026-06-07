# twoitter

mi twitter privado para guardar notas, citas, capturas, screen recordings y notas de voz. una sola persona (yo), protegido por contraseña.

stack: cloudflare workers + hono + d1 + r2 + workers ai (whisper).

## features

- **timeline tipo carrete**: la TL muestra TODOS los twoitts (roots y
  respuestas) ordenados por fecha, más recientes arriba. Cada respuesta es un
  ítem propio con cabecera "↓ en respuesta a (…)" y además sigue colgando del
  hilo de su padre. Un link a un post ya no es una página aparte: es `/#id`
  (una posición del carrete; el feed hace scroll y lo centra, auto-cargando
  páginas si hace falta).
- **respuestas colapsables**: el subárbol de respuestas de cada hilo arranca
  colapsado; un toggle "▸ N respuestas" en el pie lo despliega in-situ.
- composer con paste (cmd+v) de imágenes, vídeos y texto
- drag & drop de archivos (imagen / vídeo / audio)
- **encuestas**: botón "encuesta" en el composer; 2-10 opciones, voto único e inmutable, votantes anónimos por cookie firmada, resultados siempre visibles
- **notas de voz**: botón "grabar" en el composer (MediaRecorder). Se graban en **mp4/AAC** cuando el navegador lo soporta (Chromium ≥111 e iOS) → formato universal que suena en todos los dispositivos; fallback a webm/opus. Se reproducen vía **Web Audio API** (no un `<audio>` inline), para que suenen en iPhone aunque tenga el interruptor de silencio puesto (iOS silencia el audio inline; la Web Audio API se lo salta).
- **ubicación**: botón "ubicación" en el composer que captura las coords GPS del navegador (Geolocation API). Tras capturarlas aparece un campo opcional para nombrar el sitio (si lo dejas vacío, el post muestra las coordenadas) y una ✕ para quitarla. Se guarda `lat`/`lng` + el nombre opcional. En el pie del post: "📍 nombre o coords" con link a un mapa (Google Maps `?q=`, que en móvil abre la app de mapas). Disponible en posts y respuestas.
- **sitios guardados (geofence)**: al publicar con ubicación nombrada + coords se guarda el sitio (nombre + radio 150 m) en D1 (tabla `places`, sincronizada entre dispositivos). La próxima vez que captures GPS dentro de ese radio, el composer **autorrellena el nombre**. Auto, sin pasos extra. La página **`/places`** (menú) permite renombrarlos, ajustar su radio o borrarlos (solo el dueño; pensado para multi-usuario futuro vía la columna `owner`).
- **transcripción** de notas de voz vía Workers AI Whisper (botón "transcribir" en las acciones del post; cachea en BD, no llama dos veces)
- **página `/compose` ligera**: una vista aparte solo para publicar (sin timeline/render/gallery → ~1/3 del peso), pensada para conexiones malas. El composer principal sigue en la TL. Link en el menú.
- multi-media por post, hilos (replies), hashtags `#tag` con sidebar
- thumbnail de vídeo generado en cliente
- **editor de medios**: botón "recortar" en cada media del composer → un modal para recortar imágenes (caja de recorte de 8 tiradores), la DURACIÓN de vídeos y notas de voz (pista temporal con dos tiradores) y la ZONA de vídeos (caja de recorte, activable con "recortar zona" para no tapar los controles nativos). Re-comprime desde el original, no-destructivo y re-editable.
- player de audio custom (monoespaciado, accent, sin chrome nativo feo)
- permalinks por post (`/#id`) para citar — posición en el carrete (la vieja
  ruta `/post/:id` redirige 301 a `/#id`)
- export json completo (`/api/export`)
- **loader** de skeletons al abrir, así no hay pantallazo en blanco mientras carga el primer fetch
- **feedback de subida**: barra por cada media (compresión y subida con % real vía XHR) + el botón pasa a "publicando…" durante el submit
- **rail** vertical del hilo que crece/encoge animado con el twoitt activo — incluye cuando se abre el cuadro de responder, cuando cargan imágenes lazy y cuando aparece una transcripción (un `ResizeObserver` lo mantiene a medida)

## setup

```bash
npm install

# crear d1, copiar el database_id al wrangler.toml
npm run db:create

# aplicar schema en remoto
npm run db:migrate:remote

# crear bucket r2
npm run r2:create

# secrets
wrangler secret put PASSWORD        # tu contraseña
wrangler secret put AUTH_SECRET     # cualquier string largo aleatorio

# login para que el binding `AI` (Workers AI) funcione desde wrangler dev
# y deploy. Sólo hace falta la primera vez.
wrangler login

# deploy
npm run deploy
```

## desarrollo local

`wrangler dev` no usa los `wrangler secret` (esos son de producción): lee los secrets de un archivo **`.dev.vars`** en la raíz (gitignored). Para poder loguearte en local créalo:

```
PASSWORD=tu-contraseña-local
AUTH_SECRET=cualquier-string-largo-aleatorio
```

luego:

```bash
npm run db:migrate          # aplica schema.sql a la D1 LOCAL (.wrangler/)
npm run db:migrate:001      # + migraciones, en local
npm run db:migrate:002
npm run db:migrate:003
npm run dev                 # http://localhost:8787
```

la D1 y el R2 locales viven en `.wrangler/` y se crean solos. el binding `AI` (Whisper) en local sí llama a Workers AI real, así que necesita `wrangler login`.

## migraciones

los `npm run db:migrate:NNN[:remote]` aplican `migrations/NNN_*.sql` y son **idempotentes en intención** pero NO con `ALTER TABLE`: si una migración ya está aplicada da "duplicate column" — se ignora, la columna ya existe.

| migración | qué hace |
|-----------|----------|
| 001       | `posts.deleted_at` (soft delete) |
| 002       | `media.transcript` (cache de transcripciones de audio) |
| 003       | `polls`, `poll_options`, `poll_votes` (encuestas) |
| 004       | `posts.location` / `posts.lat` / `posts.lng` (ubicación) |
| 005       | `places` (sitios guardados / geofence) |
| 006       | `places.owner` (dueño del sitio, multi-usuario futuro) |

al añadir una migración nueva: actualizar `schema.sql` (para clones desde cero) Y crear el `.sql` en `migrations/` (para DBs vivas).

## notas de voz + transcripción

- el botón "grabar" usa `MediaRecorder` con prioridad `audio/webm;codecs=opus` → `audio/ogg;codecs=opus` → `audio/mp4`. grabamos opus a 24 kbps mono (~3 KB/s, ver recorder.js), no recomprimimos en cliente.
- **reproducción por Web Audio API** (`audio-player.js`): NO reproducimos el `<audio>` (en iOS el interruptor de silencio lo muta inline); decodificamos la nota a un `AudioBuffer` y la sonamos por el `AudioContext`, que ignora el silencio. El `<audio>` solo aporta `src` (decodificar) y `duration`; el progreso/tiempo lo lleva un reloj rAF basado en `ctx.currentTime`. Fallback al elemento si no hay `AudioContext` o el formato no decodifica (p.ej. una nota webm de escritorio en iPhone — ese caso cruzado no es solucionable en cliente: el ffmpeg.wasm aquí solo encodea ogg/vorbis, que iOS tampoco reproduce).
- al pulsar "transcribir" en las acciones del post (sólo visible si hay audio sin transcript y estás logueado), se llama a `POST /api/posts/:id/transcribe` que descarga el blob de R2 y lo pasa por `@cf/openai/whisper-large-v3-turbo` con `language: "es"`. el resultado se guarda en `media.transcript` y queda cacheado.
- cuota: el free tier de Workers AI da ~10k neuronas/día, suficiente para decenas de minutos de transcripción. para cambiar el idioma (auto-detectar o forzar otro), editar `WHISPER_LANGUAGE` en `src/index.ts`.

## ubicación

- el composer tiene un botón "ubicación". Al pulsarlo usa `navigator.geolocation.getCurrentPosition()` (requiere **HTTPS** — el dominio lo es; localhost también) para capturar `lat`/`lng`. No hay reverse-geocoding ni servicios externos: las coords se guardan crudas.
- sólo **tras** capturar las coords aparece un campo opcional para escribir el nombre del sitio (máx 120 chars) y una ✕ para quitar la ubicación. Si escribes un nombre se guarda en `posts.location` (lo que se muestra); si lo dejas vacío, el pie del post muestra las coordenadas.
- `posts.lat`/`posts.lng` + `posts.location` (opcional). El render pinta `📍 <nombre o coords>` con link a `https://www.google.com/maps?q=lat,lng` — en móvil abre la app de mapas instalada; en escritorio, la web. Para otro proveedor (Apple Maps, un `geo:` URI, OSM…) es una línea en `renderLocation` (render.js).
- la parte de GPS/permiso NO es testeable headless → se verifica en Brave. El flujo de UI (revelar campo, ✕, reset al publicar) y el render sí están verificados en el preview.
- **sitios guardados (geofence)**: al publicar con nombre + coords, el server (`persistPost`) guarda el sitio en la tabla `places` si no hay ya uno dentro de su radio (150 m; dedup por distancia vía `haversineMeters` en `src/geo.ts`). El composer pide `GET /api/places` al cargar (cache en `state.savedPlaces`) y, al capturar GPS, autorrellena el nombre del sitio más cercano dentro de su radio (haversine espejo en `utils.js`).

## arquitectura (data-flow)

```
navegador  (public/, ES modules; entry public/app.js)
   │  fetch vía js/api.js  —  cookie de sesión (HMAC) + header x-twoitter-csrf
   ▼
Worker Hono  (src/index.ts)  —  middleware: COOP/COEP · requireAuth · requireCsrf · rateLimit
   ├─ /api/posts · /api/posts/:id · /poll/vote · /export  →  src/db.ts  →  D1 (SQLite)
   ├─ /api/places (GET·PATCH·DELETE)  →  src/db.ts  →  D1 (sitios guardados / geofence)
   ├─ /api/upload                →  R2 (STORAGE)   ← el cliente sube el blob YA comprimido
   ├─ /r2/*                      →  R2 (proxy de lectura, cache-control immutable)
   ├─ /api/posts/:id/transcribe  →  Workers AI (Whisper)  →  cachea en D1 (media.transcript)
   ├─ /            → index.html (timeline)
   ├─ /compose     → compose.html (página ligera solo-publicar)
   └─ /places      → places.html (gestión de sitios guardados)
```

- la **ubicación** NO añade endpoint de escritura: las coords se capturan en cliente (`navigator.geolocation`) y viajan en el body de `POST /api/posts` (`location`/`lat`/`lng`). El geofence se auto-guarda server-side en `persistPost` y se lee vía `GET /api/places`.
- **cross-origin isolation (COOP/COEP)**: un middleware `app.use("*")` pone `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` en TODA respuesta. Habilita `SharedArrayBuffer` (ffmpeg.wasm multi-thread) desde el primer byte, así que ya **no usamos `coi-serviceworker.js`** (forzaba recargas en la primera visita). app.js desregistra el SW viejo de usuarios que vuelven.

convenciones:

- **payloads snake_case**: la API devuelve las columnas de D1 tal cual (`created_at`,
  `parent_id`, `r2_key`, `reply_count`, `my_vote_id`…). El cliente las consume sin
  renombrar; su estado interno propio va en camelCase (`nextCursor`, `localId`, `previewUrl`…).
- **CSRF**: todo POST/DELETE exige el header `x-twoitter-csrf` (cualquier valor no vacío)
  además de la cookie de sesión `SameSite=Lax` (`requireCsrf`).
- **errores**: siempre `{ error: string }` + status HTTP (400/401/403/404/409/413/422/500).
- **rate limits** (bindings nativos de Workers): `WRITE_LIMITER` (upload + crear posts,
  authed), `VOTE_LIMITER` (voto, público), `TRANSCRIBE_LIMITER` (transcribe).
- **compresión en cliente**: imagen → WebP (canvas/WASM), vídeo → VP8/WebM (ffmpeg.wasm),
  audio → Opus directo del recorder. El server revalida tamaño y tipo antes de aceptar.

Historial de cambios: ver [`CHANGELOG.md`](CHANGELOG.md).

## estructura

```
src/
  index.ts        rutas Hono: auth, posts CRUD, polls/voto, upload, transcribe,
                  export, proxy /r2 + middleware CSRF (header x-twoitter-csrf)
  auth.ts         cookie de sesión firmada (HMAC) + requireAuth + cookie de
                  votante anónimo (tv_id) para encuestas
  db.ts           queries D1 (posts, replies, hashtags, polls, soft-delete);
                  IN-queries troceadas por el límite de parámetros de D1
  media.ts        validación/clasificación de uploads a R2
  hashtags.ts     extracción de #tags

public/
  app.js          entry point: orquesta los módulos
  js/
    pages.js          loadTimeline (pagina + auto-fetch al scroll) + deep-link
                      por hash (loadUntilHashPost) + setupTimelineComposer
    render.js         render de posts/hilos + activación (.active) + colapso
    render-poll.js    markup + voto de las encuestas (extraído de render.js)
    post-actions.js   barra de acciones del post (responder/ocultar/borrar/transcribir)
    rails.js          rail vertical: geometría + animateHeight() + acordeón de replies
    composer.js       composer principal + reply-inline + paste global
    composer-poll.js  UI de creación de encuestas en el composer
    composer-anim.js  animación abrir/cerrar del reply-inline (usa rails.animateHeight)
    media.js          orquesta compresión + subida (XHR con progreso) + submit
    preview-item.js   DOM del item de preview del composer (miniatura + overlay de estado)
    compressor.js     barril → compressor-video.js (ffmpeg.wasm) / compressor-image.js (canvas/webp)
    editor.js         modal del editor: imagen (crop) + vídeo/audio (trim temporal)
    editor-geom.js    math pura del editor (crop/trim, sin DOM; testeada con vitest)
    editor-cropbox.js primitiva UI de la caja de recorte espacial (8 tiradores)
    editor-trimtrack.js primitiva UI de la pista de recorte temporal (trim)
    modal.js          scaffold de modal (role=dialog + aria-modal) + focus-trap, compartido
    gallery.js        galería: stage + thumbs + lightbox (crossfade compartido)
    audio-player.js, recorder.js               player de audio custom + grabación de notas
    menu.js, hashtags.js, hidden.js, auth.js, api.js, utils.js, state.js
  style.css       estilos (un solo archivo)
```

dominio: `twoitter.meowrhino.studio`
