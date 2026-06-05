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
- **notas de voz**: botón "grabar" en el composer (MediaRecorder, opus)
- **transcripción** de notas de voz vía Workers AI Whisper (botón "transcribir" en las acciones del post; cachea en BD, no llama dos veces)
- multi-media por post, hilos (replies), hashtags `#tag` con sidebar
- thumbnail de vídeo generado en cliente
- **editor de medios**: botón "recortar" en cada media del composer → un modal con caja de recorte libre (8 tiradores) para recortar imágenes antes de publicar; re-comprime desde el original (no destructivo, re-editable). Recorte de vídeo (temporal + espacial) y trim de audio en camino.
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

al añadir una migración nueva: actualizar `schema.sql` (para clones desde cero) Y crear el `.sql` en `migrations/` (para DBs vivas).

## notas de voz + transcripción

- el botón "grabar" usa `MediaRecorder` con prioridad `audio/webm;codecs=opus` → `audio/ogg;codecs=opus` → `audio/mp4`. grabamos opus a 24 kbps mono (~3 KB/s, ver recorder.js), no recomprimimos en cliente.
- al pulsar "transcribir" en las acciones del post (sólo visible si hay audio sin transcript y estás logueado), se llama a `POST /api/posts/:id/transcribe` que descarga el blob de R2 y lo pasa por `@cf/openai/whisper-large-v3-turbo` con `language: "es"`. el resultado se guarda en `media.transcript` y queda cacheado.
- cuota: el free tier de Workers AI da ~10k neuronas/día, suficiente para decenas de minutos de transcripción. para cambiar el idioma (auto-detectar o forzar otro), editar `WHISPER_LANGUAGE` en `src/index.ts`.

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
    editor.js         modal del editor de medios (recorte de imagen; vídeo/audio en camino)
    editor-geom.js    math pura del editor (crop/trim, sin DOM; testeada con vitest)
    editor-cropbox.js primitiva UI de la caja de recorte (8 tiradores + cuerpo)
    modal.js          scaffold de modal (role=dialog + aria-modal) + focus-trap, compartido
    gallery.js        galería: stage + thumbs + lightbox (crossfade compartido)
    audio-player.js, recorder.js               player de audio custom + grabación de notas
    menu.js, hashtags.js, hidden.js, auth.js, api.js, utils.js, state.js
  style.css       estilos (un solo archivo)
```

dominio: `twoitter.meowrhino.studio`
