# Changelog

Cambios notables de twoitter. Single-user, sin versionado semver: las entradas
van por **fecha de sesión**. El detalle de cada una vive en `docs/TODO.md`
(secciones "Done"), en `docs/handoffs/` y en `git log`.

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
