# Changelog

Cambios notables de twoitter. Single-user, sin versionado semver: las entradas
van por **fecha de sesión**. El detalle de cada una vive en `docs/TODO.md`
(secciones "Done"), en `docs/handoffs/` y en `git log`.

## 2026-06-07 — gestión de sitios, audio universal, crop de vídeo y modularización

Tercera tanda del día (todo a la vez por petición). Suite 254→**263 tests**;
`tsc --noEmit` + bundles esbuild (app.js + compose.js, metafile sin render/rails/
gallery) en verde.

### Added
- **Gestión de sitios guardados** (`/places`): renombrar, ajustar radio o borrar.
  Tabla `places` gana `owner` (migración 006); endpoints `PATCH`/`DELETE
  /api/places/:id` filtran por dueño (hoy un solo usuario `'me'`, pensado para
  multi-usuario: solo el dueño edita/borra). Nueva página `places.html`/`places.js`
  + link en el menú. Verificado E2E (renombrar/borrar) en el preview.
- **Recorte ESPACIAL de vídeo (zona)**: el editor gana una caja de recorte sobre el
  vídeo, activable con el botón "recortar zona" (para no tapar los controles nativos
  que sirven para previsualizar el trim). Reusa la primitiva del crop de imagen
  (`createCropBox`) + la geometría testeada; `compressVideo` mapea el crop
  `{sx,sy,sw,sh}`→`{x,y,w,h}` para `buildVideoArgs` (ffmpeg `-vf crop`). El vídeo
  admite trim + crop a la vez. ⚠️ El recompresado con ffmpeg se verifica en Brave
  (como el trim F6/F7); la UI (toggle, overlay posicionado, controles protegidos) y
  la matemática están verificadas.

### Changed
- **Notas de voz en mp4/AAC** (universal): `recorder.js` ahora prioriza `audio/mp4`,
  que graban TANTO iOS como el Chromium moderno → una nota suena en todos los
  dispositivos (antes webm de escritorio no sonaba en iPhone). Fallback a webm/opus.
- **Modularización**: extraído el lightbox de `gallery.js` → `lightbox.js`, con las
  primitivas compartidas (mediaItemHtml/readMedia/preloadImage/crossfadeSwap) en
  `gallery-core.js` para no crear un ciclo gallery↔lightbox. Borrado
  `coi-serviceworker.js` (muerto: COOP/COEP los sirve el Worker). `rails.js` ya
  estaba bien documentado (sin cambios).

## 2026-06-07 — audio en iPhone, ubicaciones nivel 2 y carga más rápida

Continuación de la sesión de ubicación. Plan en `~/.claude/plans/` (5 frentes).
Suite 254 tests verdes; `tsc --noEmit` y bundles esbuild de `app.js` (111.8 KB) y
del nuevo `compose.js` (45 KB, metafile confirma que excluye render/rails/gallery)
en verde.

### Fixed
- **Notas de voz no sonaban en iPhone**: en iOS el interruptor de silencio muta el
  `<audio>` reproducido inline. Reescrito `audio-player.js` para reproducir por
  **Web Audio API** (`decodeAudioData` → `AudioBufferSourceNode`, que ignora el
  silencio); el `<audio>` queda solo para `src`/`duration` y el progreso lo lleva un
  reloj rAF (`ctx.currentTime`), no los eventos del elemento. Fallback al elemento si
  no hay `AudioContext` o el formato no decodifica. ⚠️ El sonido en sí se verifica en
  el iPhone (no testeable headless); el motor (decode, reloj, pausa, seek) sí verificado.
- **La ubicación se abreviaba** con "…" aunque cupiera: `.post-loc` ya no trunca
  (sin `max-width`/`ellipsis`); `.post-foot` con `flex-wrap` para bajar de línea.

### Added
- **Sitios guardados (geofence)**: tabla `places` en D1 (migración 005). Al publicar
  con nombre + coords, `persistPost` auto-guarda el sitio si no hay otro dentro de su
  radio (150 m; dedup por distancia, `haversineMeters` en `src/geo.ts`). El composer
  pide `GET /api/places` al cargar y autorrellena el nombre cuando capturas GPS cerca.
  Verificado E2E en el preview (auto-save + autofill a ~30 m, no a ~600 m).
- **Página `/compose` ligera**: vista aparte solo-publicar (sin timeline/render/
  gallery), para conexiones malas. Requirió extraer `makeInlineComposer` a
  `inline-composer.js` (así `composer.js` deja de arrastrar `render.js` y todo el
  grafo del timeline). Nuevo `compose.html` + `compose.js`; ruta `/compose`; link en
  el menú. El composer sigue también en la TL.

### Changed
- **Cross-origin isolation (COOP/COEP) desde el Worker**: middleware `app.use("*")`
  pone `COOP: same-origin` + `COEP: require-corp` en toda respuesta → `SharedArrayBuffer`
  (ffmpeg.wasm) activo desde el primer byte SIN `coi-serviceworker.js`, que forzaba
  1-2 recargas en la primera visita (lento sobre todo en móvil). Quitado el `<script>`
  del coi en index.html; app.js/compose.js desregistran el SW viejo. Verificado:
  `crossOriginIsolated=true` sin service worker, sin recargas.
- **Tests** (+14 → 254): `geo.test.ts` (haversine), places en `db.test.ts` y geofence
  en `post-handler.test.ts` (auto-save + dedup + casos sin nombre/sin coords),
  `/api/places` en `routes.test.ts`.

## 2026-06-07 — ubicación en los twoitts

### Added
- **Ubicación por post**: botón "ubicación" en el composer (principal e inline) que
  captura las coords GPS del navegador (`navigator.geolocation`). Tras capturarlas
  aparece un campo opcional para nombrar el sitio + una ✕ para quitarla; si no escribes
  nombre, el post muestra las coordenadas. Se guarda `posts.location` (nombre opcional) +
  `posts.lat`/`posts.lng`. En el pie del post: `📍 <nombre o coords>` con link a un mapa
  (`google.com/maps?q=lat,lng`, que en móvil abre la app de mapas). SIN servicios externos
  ni endpoints nuevos: las coords viajan en el body de `POST /api/posts`.
  Migración `004_add_location.sql`. Nuevo módulo `composer-location.js` (captura + revelar
  campo + ✕ + reset); `renderLocation` (render.js); `parseCoords` (index.ts). El CTE de
  `getDescendants` arrastra los campos para que las replies también lleven ubicación.
- Tests nuevos (db roundtrip + replies, render del pie con coords/nombre + escape, payload
  del composer, regresión de coords) → **240 totales**. `tsc --noEmit` + bundle esbuild
  del grafo en verde.

### Fixed
- **Bug cazado en la verificación (preview)**: un post con nombre/etiqueta pero sin GPS
  acababa con `lat/lng = 0,0` y un link a mapa espurio, porque `Number(null)` es `0` (un
  punto válido). `parseCoords` ahora trata null/undefined/"" como "sin coord". Con test.

### Notas
- Primera iteración llevaba reverse-geocoding (coords→nombre vía Nominatim, endpoint
  `/api/geocode`) y un campo de texto siempre visible; se **simplificó** a petición:
  solo botón → coords, nombre opcional a posteriori. Nominatim/geocode eliminados.
- **Pendiente (humano, no testeable headless)**: verificar el botón GPS en Brave real
  (permiso → captura → publicar). El flujo de UI y el render ya verificados en el preview.

## 2026-06-06 — editor: trim de vídeo y notas de voz (F6/F7)

### Added
- **Recorte temporal (trim) de vídeo y notas de voz**: el botón "recortar" abre un
  modal con el medio (controles nativos, sin autoplay) + una pista de tiempo con dos
  tiradores inicio/fin para elegir el fragmento; "aplicar" re-comprime al recorte
  (no-destructivo, re-editable). El plumbing del compresor ya lo soportaba
  (`buildVideoArgs -ss/-t`, `trimAudio`); se añadió la UI: `editor-trimtrack.js` +
  `solveTrimConstraints`/`rangeToTrim` (editor-geom.js, testeados) +
  `openVideoEditor`/`openAudioEditor` (editor.js). Incluye el workaround del webm con
  `duration=Infinity` de MediaRecorder (seek forzado) para leer la duración.

### Pending
- Recorte ESPACIAL de vídeo (zona): el plumbing existe; falta la UI (caja vs controles).

## 2026-06-06 — limpieza de revisión + cobertura

### Fixed
- Deep-link `/#id` a un post oculto mostraba "ocultar" en vez de "desocultar"
  (faltaba `refreshThreadHideBtn` en `focusPostFromHash`). Con test de regresión.
- Baseline de tests en verde: `better-sqlite3` instalado y stub de `localStorage`
  (happy-dom v20 no lo expone) compartido en `test/helpers/mem-storage.ts`.
- Bitrate de audio stale en docs ("~16 KB/s" → 24 kbps mono, en README y `src/media.ts`).

### Added
- Cobertura del endpoint `/transcribe` (`test/transcribe.test.ts`) → 218 tests.
- Módulos extraídos: `modal.js` (scaffold de modal + focus-trap, compartido por
  lightbox y editor), `render-poll.js`, `preview-item.js`; helper `animateHeight()`
  compartido (acordeón + composer); `mediaKindOf` y `prefersReducedMotion` en `utils.js`.
- Documentación: sección de data-flow en el README y este CHANGELOG.

### Changed
- Refactors sin cambio de comportamiento (verificados con `npm test` + `tsc --noEmit`
  + un bundle esbuild del grafo de módulos): `crossfadeSwap` (gallery), split de
  `attachMediaAndTags` (db.ts), bitrates de audio nombrados, dedups a `utils.js`.
  12 commits sobre `main`; desplegado.
- Evaluado y NO hecho: partir `rails.js` en dos (#3) — forzaría un import circular
  acordeón↔rail; la duplicación real ya la resolvió `animateHeight()`.

### Revisión profunda nº2 (mismo día)
Segunda pasada adversaria (3 revisores en paralelo) sobre el código ya limpiado:
- **fix**: búsqueda con `q` > 200 chars devolvía el feed ENTERO (db.ts descartaba
  el filtro `LIKE`). Truncado a 200 + test de regresión.
- **dead code**: eliminadas las ramas de la vista single-post (`#replies`/
  `#postContainer`) en rails/render/post-actions (la vista ya no existe).
- **refactor**: `STANDARD_CURVE`/`ANIM_MS` a utils.js (curva+duración antes
  triplicadas); `parseId` estricto para los `:id` ("5abc" ya no actúa sobre el 5);
  `decodeOrientedBitmap` compartido (editor + compresor decodifican idéntico);
  `_storage` muerto fuera de `deletePost`; el modal del editor se revela tras
  decodificar; cancelar reply sin callback redundante.
- Backend verificado limpio (SQL parametrizado, sin path traversal, allowlist de
  upload sólida). Lightbox→módulo y split de index.ts/db.ts: diferidos.

## 2026-06-05 — carrete plano, encuestas y editor de medios (F0–F5)

### Added
- **Timeline tipo carrete**: la TL muestra todos los posts (roots + replies) por
  fecha; cada reply es ítem propio con "↓ en respuesta a (…)" y sigue anidada.
  Permalink = `/#id` (posición en el carrete, con auto-fetch hasta encontrarlo).
- **Encuestas**: tablas `polls`/`poll_options`/`poll_votes`, voto anónimo inmutable
  por cookie firmada `tv_id`, resultados siempre visibles.
- **Respuestas colapsables** (acordeón multinivel, capa a capa) + scroll-spy que
  actualiza la URL `/#id` al post visible.
- **Editor de medios (F0–F5)**: recorte de imagen en un modal (math pura testeada
  en `editor-geom.js`, caja de recorte en `editor-cropbox.js`, seam de reproceso en
  `media.js`). Vídeo (F6) y audio (F7) pendientes.
- Rate limits (`WRITE`/`VOTE`/`TRANSCRIBE`) + tests: frontend con red, endpoints
  HTTP (`app.request`) y backend D1 sobre better-sqlite3.

### Removed
- Vista `/post/:id` y `post.html`: el server redirige 301 `/post/:id → /#id`.

### Fixed
- La cookie `tv_id` a 2 años reventaba el voto (Hono capa el Max-Age a 400 días).
- Nonce en `deleted_at` para que `restorePost` no resucite posts de otro borrado
  colisionado al milisegundo.

## 2026-05-27 — API wrapper + extracción de acciones

### Added
- `js/api.js`: wrapper único de `fetch` (CSRF + JSON + manejo de error), 9 call sites.
- `js/post-actions.js`: render HTML + handlers + bindings de la barra de acciones
  (`render.js` −57%). `src/media.ts uint8ToBase64()` extraído con tests de chunking.

### Fixed
- Gap visual en threads profundos, `flex-wrap` de la barra en móvil, y la barra de
  acciones apareciendo en medio del thread tras crear el primer reply.

## 2026-05-21 — modularización + rails + primeros tests

### Added
- `public/app.js` (944 líneas) → 10 módulos ES en `public/js/`.
- Rails verticales del thread (CSS + `ResizeObserver`), upload-on-submit (sin blobs
  huérfanos en R2), a11y (role/tabindex/aria-live, `prefers-reduced-motion`), y
  vitest (31 tests iniciales).
- Compresión en cliente (ffmpeg.wasm para vídeo + canvas/WebP para imagen) y aviso legal.
