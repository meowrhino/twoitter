# TODO

Lista de mejoras pendientes priorizadas por impacto vs esfuerzo. Generadas tras un deep review del proyecto (4 agentes Explore en paralelo sobre `public/js/`, `src/`, `style.css` y patrones transversales) el 2026-05-27. Lo que está marcado [done] ya está en producción.

## Pendiente

> Estado al cierre de la sesión 2026-06-05: TODO lo de valor alto/medio está
> hecho y desplegado (ver "Done" abajo). Lo que queda es lo de abajo, con mi
> recomendación honesta baked-in para retomarlo en frío.
>
> Segunda pasada el 2026-06-05 (review en frío con la app en vivo + un agente
> Explore): NO salieron bugs nuevos. El backend aguanta los edge-cases (id no
> numérico→400, negativo/gigante→404, limit absurdo→capa a 100, JSON roto→400,
> poll de 1 opción→400, texto >4000→400, path traversal en `/r2/`→404). Los
> "hallazgos" del agente eran falsos positivos (la cookie `tv_id` persistente
> es por diseño; el shape del 409 de voto está justificado; el botón
> transcribir ya tiene guard anti-doble-click). Sigue en pie SÓLO lo de abajo.

### Lo que queda pendiente (todo menor / opcional)

- [x] **Cobertura de backend de `/transcribe`** (DONE 2026-06-06):
  `test/transcribe.test.ts` cubre el endpoint (401/403, 400 id, 404 sin-audio,
  200 cached sin tocar el modelo, 404 blob ausente, 500 Whisper falla, 422 vacío,
  200 OK con audio base64 + language + persistencia) y de paso
  `getAudioMediaForPost`/`setMediaTranscript`. AI y STORAGE stubbeados en el env.
  10 tests → 218 totales. Ya no queda cobertura de backend pendiente.

### Útil pero baja urgencia

- [ ] **Docs**: en el README, un diagrama del data-flow (cliente → API →
  D1/R2/Workers AI) + convenciones (snake_case server vs camelCase client, header
  CSRF `x-twoitter-csrf`, error shape `{ error: string }`, los 3 rate-limiters).
  Y un **CHANGELOG.md** (hoy no hay versionado de cambios de API shape).
  **Recomendación:** rápido y agradable cuando apetezca.

### Descartado a propósito (NO hacer salvo que cambie el contexto)

- [x] **Reordenar `style.css` in-situ** (HECHO 2026-06-05): los 5 trozos
  dispersos del `.post` ahora van juntos, audio con media, índice al principio
  + títulos en las secciones que no los tenían. Reordenado por bloques con un
  script validado por `sort` (mismas líneas exactas, solo reubicadas → cero
  pérdida) y verificado en el browser (incluida la cascada móvil). De grasa real:
  quitado `--serif`/Merriweather del `@import` (fuente que nadie usaba) y
  arreglado un bug latente (botón "borrar" recortado en móvil: el `@media` estaba
  pisado por la regla base; movido para que gane).
- [ ] ~~**Partir `style.css` en varios archivos**~~. SIGUE DESCARTADO sin bundler:
  o un build que concatene, o varios `<link>` (mantener el orden en 3 HTML), o
  `@import` (waterfall). El reorden in-situ de arriba ya dio la mantenibilidad
  sin el riesgo de carga. Reconsiderar solo si entra un bundler.
- [ ] ~~**CSRF dual-token**~~. DESRECOMENDADO para esta app: un solo usuario,
  `SameSite=Lax` ya previene el cross-origin. Es endurecimiento contra un
  escenario hipotético (servir la cookie con `SameSite=None`, p.ej. embed/
  subdominio) que hoy no aplica. Reconsiderar SOLO si eso cambia.
- [ ] **sessionStorage**: `state.js` guarda `CSRF_HEADERS` siempre. Cosmético,
  no es vuln. Trivial si molesta.

## Done (sesión 2026-06-06)

Revisión escéptica de 15 hallazgos: verificados de forma adversaria (citando
código), plan por fases, ejecución completa. **12 commits en `main`**, desplegado.
Suite 138→**208 tests** verdes; `tsc --noEmit` y un bundle esbuild de `app.js`
(valida el grafo de módulos del frontend, que ningún test cargaba) en verde.

- [x] **Baseline de tests verde**: faltaba `better-sqlite3` en node_modules
  (`npm install`) y happy-dom v20 no expone `localStorage` → stub `MemStorage`
  compartido (`test/helpers/mem-storage.ts`) en render/xss/pages. Antes: 6 suites rojas.
- [x] **#1 bug (deep-link)**: `focusPostFromHash` no refrescaba el botón
  ocultar/desocultar como la ruta de click → un post alcanzado por `/#id` mostraba
  "ocultar" estando ya oculto. Fix + test de regresión (probado no-vacuo). El
  "stagger roto" del hallazgo era falso (`syncThreadActiveFlags` ya lo aplica).
- [x] **#14 docs**: bitrate de audio stale ("~16 KB/s") → 24 kbps mono en README + `src/media.ts`.
- [x] **#7 `render-poll.js`**: markup + voto de encuestas fuera de render.js.
- [x] **#5 `crossfadeSwap()`**: núcleo común de swapStage + lightbox (gallery.js).
- [x] **#12 `db.ts`**: `attachMediaAndTags` partido en `assemblePollsByPost` + `resolveParentExcerpts`.
- [x] **#15 dedups → utils.js**: `mediaKindOf`, `nextFrame`/`wait`.
- [x] **#6 `modal.js`**: scaffold de modal + focus-trap compartido por lightbox y
  editor (F6 construirá sobre él, no clona).
- [x] **#2 `preview-item.js`**: DOM del item de preview fuera de media.js.
- [x] **#13 `prefersReducedMotion()` → utils.js** (3 copias unificadas).
- [x] **#11 bitrates nombrados**: `VOICE_NOTE_BITRATE` (24k) / `AUDIO_TRIM_BITRATE`
  (96k); NO compartidos con `PRESET.audioBitrate` (128k) — códecs/contextos distintos.
- [x] **#4 `animateHeight()`**: patrón WAAPI duplicado (acordeón + composer)
  unificado; vive EN rails.js para evitar import circular (composer-anim lo importa).
- [x] **#10**: comentado el hook muerto `ctx.urls` (lo cableará F6).
- [x] **README al día**: editor de medios en features + estructura con los módulos nuevos.

Evaluado y NO hecho (a propósito):
- **#3 partir rails.js**: el split 2-way fuerza un import circular (acordeón↔rail);
  el 3-way limpio es grande/arriesgado sobre código de animación sin arreglar bug.
  #4 ya extrajo la duplicación real → se deja rails.js como está.
- **#8** (even-rounding en compressor-image): falso positivo — el clamp impide OOB y
  WebP no exige dims pares. **#9** (ramas vídeo/trim de `applyEdit`): andamiaje
  intencional de F6, ya comentado; se valida al cablear `openVideoEditor`.

⚠️ Pendiente de ojo humano: las **animaciones** (rail/acordeón/crossfade/modales)
son behavior-preserving por construcción pero no unit-testeables (happy-dom sin
`Element.animate`; preview headless) → ojearlas en Brave real.

## Done (sesión 2026-06-05)

Reorganización grande de la TL + encuestas + revisión:

- [x] **Carrete plano**: la TL muestra TODOS los posts (root + replies) por
  fecha; cada reply es ítem propio con "↓ en respuesta a (…)" Y sigue anidada.
  Link a un post = `/#id` (posición; scroll + auto-fetch hasta encontrarlo).
- [x] **Vista `/post/:id` ELIMINADA** (y `post.html`, `loadSinglePost`, `POST_ID`).
  El server redirige 301 `/post/:id → /#id`. → invalida el `[x]` de abajo sobre
  validar `POST_ID`/`loadSinglePost` (ese código ya no existe).
- [x] **Encuestas (polls)**: tablas + voto anónimo por cookie firmada `tv_id`.
  Fix: la cookie a 2 años reventaba el voto (Hono capa Max-Age a 400 días).
- [x] **Respuestas colapsables**: subárbol colapsado por defecto + toggle
  "▸ N respuestas". Fix del contador dinámico (root usa `.resp-toggle`).
- [x] **Troceado de queries D1** (`selectByIds`) por el límite de ~100 params
  — el `limit=500` reventaba el timeline en prod con 500.
- [x] **`getDescendants()`**: extraído el CTE recursivo duplicado de listPosts/getReplies.
- [x] **Extraídos `composer-poll.js` y `composer-anim.js`** (composer.js 441→259).
- [x] **Límites poll + media desde el server** (`/api/me` → `POLL_LIMITS`/`MEDIA_LIMITS`),
  fuente única; y validación de tamaño de upload en cliente antes de subir.
- [x] **Táctil 44px** en `.post-actions button`, login fluido en móvil, tokens de radio.
- [x] Borradas reglas CSS muertas (`.audio-transcript[hidden]`, `.menu-link letter-spacing`).
- [x] README al día.

Segunda pasada (review en frío + tests de frontend + refactor CSS + acordeón):
- [x] **Reorden de `style.css` + limpieza** (ver "Descartado" arriba, ahora [x]):
  índice + secciones agrupadas + `--serif`/Merriweather fuera + fix del botón
  "borrar" en móvil. Verificado en browser, cero regresiones.
- [x] **Acordeón multinivel de respuestas**: cada post con replies nace plegado
  con su propio toggle "N respuestas" (antes solo el root del BLOQUE colapsaba y
  al abrirlo se mostraban TODOS los niveles de golpe). Ahora el hilo se abre capa
  a capa: abrir #88 muestra #89 plegado, abrir #89 muestra #90. `render.js`
  (collapsible por nivel) + `rails.js` (el contador usa toggle a cualquier nivel).
  3 tests nuevos/actualizados → 170 totales. El permalink `#id`→scroll intacto.
- [x] **Scroll-spy: la URL `/#id` sigue al post visible** (inspirado en la web de
  mirandaperezhita): conforme scrolleas, `history.replaceState` actualiza el hash
  al post cuyo borde superior cruza la línea de activación (40% del viewport), sin
  disparar `hashchange` (→ sin scroll-jump). Arranca con la URL limpia (solo actúa
  al scrollear). En `pages.js`: listener de scroll + throttle por timestamp (NO
  IntersectionObserver ni rAF — ninguno de los dos dispara fiable en el preview
  headless). Cierra la simetría del permalink: clic en #id→scroll, y scroll→#id.
  ⚠️ Verificación: el código y el mecanismo están confirmados (el módulo carga y
  el hash se actualiza; lógica probada con handler equivalente), pero el
  SEGUIMIENTO exacto no se pudo demostrar end-to-end en el preview porque su
  `getBoundingClientRect` no se sincroniza con `scrollTo` programático. Confirmar
  con un scroll real en el navegador.
- [x] **Fix: el `.status` tapaba el player de audio en el composer**. El overlay
  de estado (barra de subida + "X MB · formato", `position:absolute; bottom:0`
  con gradiente negro) está pensado para la esquina de un thumbnail cuadrado;
  sobre el `.item-audio` (player horizontal) se superponía a la barra de progreso
  y los tiempos, oscureciéndolos. Fix (`style.css`): para `.item-audio`, el item
  pasa a `flex column` y el `.status` va EN FLUJO debajo del player (no overlay,
  sin gradiente). Confirmado por medición: `statusTapaProgress` true → false.
- [x] **Frontend tests del flujo CON RED** (16 nuevos → 168 totales):
  `test/composer.test.ts` (8) cubre `wireComposer`: POST /api/posts con CSRF +
  body correcto, parent_id en replies, reset de textarea/preview al publicar,
  feedback del botón ("publicando…" + disabled→restaurado), form vacío sin
  fetch, error de red que conserva el texto, y encuesta (poll.options en el
  body + validación cliente de <2 opciones). `test/pages.test.ts` (8) cubre
  `loadTimeline`: render por chunks, `#loadMore` según `nextCursor`, limpieza de
  skeletons, paginación con cursor (append, no replace), robustez ante 5xx /
  respuesta sin `posts`, y el auto-fetch del IntersectionObserver (sentinel que
  intersecta → carga la página siguiente con su cursor; no intersecta → nada).
  Patrón happy-dom + `fetch` stubbeado, igual que render.test.ts.

Backlog atacado al final de la sesión:
- [x] **Rate limit en endpoints authed** (WRITE_LIMITER 100/min para upload+posts,
  TRANSCRIBE_LIMITER 15/min para transcribe) + middleware rateLimit() que DRYea
  el patrón (el voto público también pasó a usarlo).
- [x] **Tests de endpoints HTTP** (test/routes.test.ts vía app.request): POST
  /api/posts (auth/CSRF/crear/vacío), voto (CSRF/200/409/404), redirect 301; y
  db (syncHashtags, exportAll). 152 tests.
- [x] **Tests de backend** (18): adapter D1 sobre better-sqlite3 (no pool-workers,
  ver commit). Cubre listPosts/cursor/parent_excerpt, getReplies, polls/voto,
  deletePost cascada + restore. **Encontró y arregló un bug real**: el nonce de
  `deleted_at` se evaluaba por fila → restore solo revivía el root.
- [x] **Tests de frontend** (12 render + 4 anti-XSS + 11 del POST handler):
  reply-context, colapso, contador, encuesta, escapado.
- [x] **Rate limit del endpoint de voto** (público) vía binding nativo de Workers.
- [x] **Partido el POST handler** en validatePostBody + persistPost (testeables).
- [x] Token `--accent-overlay-light`; auditoría de innerHTML (sin agujeros) con
  tests de regresión.

Evaluado y descartado (falso positivo) en esta sesión:
- Tokenizar el spacing (los px reales no caen en rejilla base-4).
- Token `--breakpoint-tablet` (las custom properties no van en `@media`).
- "Código muerto" en `hidden.js` (`unhide`/`listHidden`/`clearHidden` → usados en tests).

## Done (esta sesión, 2026-05-27)

- [x] Fix bug visual gap entre último twoitt y botones en threads profundos (`padding-bottom: 0` en .post anidados cuando hay activo, luego siempre).
- [x] Fix bug mobile: `flex-wrap` en `.post-actions` con `max-height: 100px` para 2 filas.
- [x] Fix bug barra de acciones aparece en medio del thread tras crear primer reply (`insertBefore(nested, actions)` en `composer.js`).
- [x] `public/js/api.js` — wrapper único de `fetch` con CSRF + JSON + error handling. 9 call sites migrados.
- [x] `public/js/post-actions.js` — extraídos render HTML, handlers (doHide/doDelete/doTranscribe), bindings (bindThreadActions/bindSinglePostActions), y helper `bindButtonsOnBar`. `render.js` reducido de 365 a 156 líneas (-57%).
- [x] `padding-bottom: 0` siempre en `.post` — el thread se ve compacto sin diferencia entre estados activo/inactivo.
- [x] CSS token `--curve-standard: cubic-bezier(0.4, 0, 0.2, 1)` (era 8+ literales).
- [x] Validar `POST_ID` en `state.js` — entero positivo, sin sufijos basura. `loadSinglePost` muestra "id inválido" para `/post/abc`.
- [x] `audio-player.js fmt` → `fmtTime` para evitar colisión homónima con `utils.js fmt`.
- [x] `navigateToPost` inlineado (1 línea, 1 caller).
- [x] `src/media.ts uint8ToBase64()` — extraído el chunking de `fromCharCode.apply`. Tests para chunk boundaries.
- [x] `src/db.ts deletePost`: nonce hex en `deleted_at` para evitar que `restorePost` resucite posts de otro batch borrado en el mismo milisegundo.
- [x] Sistema de rails simplificado a CSS puro (sesiones anteriores): `overflow: hidden` en root + `bottom: -9999px` en `::before`, sin JS de medición.
- [x] Rail amarillo del activo via `.post.clickable.active::before { background: accent }` (sesiones anteriores).
- [x] Fix botones inactivos cuando el root del thread era el activo (`querySelector` no matchea el root) — `target()` usa `.matches()` primero.
- [x] 21 nuevos tests + 1 fix de test stale → **99 tests pasando** en 10 archivos.

## Cosas que se evaluaron y se decidieron NO hacer

- **"El rail amarillo se corta antes de la barra de acciones"** (investigado a
  fondo el 2026-06-05, BLOQUE con replies expandidos + root activo): NO es un
  corte real. Verificado con `outline` sobre el `::after` + un marker absoluto a
  `root.top + railTop + railHeight`: el rail llega EXACTO al bottom de la barra
  (`measureRail` usa `rootRect.bottom` cuando el activo tiene `.extends-to-bottom`,
  ver [rails.js](../public/js/rails.js) `measureRail`). Es **percepción**: el
  `--accent` (#e8b04a, mostaza apagado) de 2px sobre fondo negro se "apaga"
  ópticamente en los últimos ~54px porque a su izquierda queda zona vacía (los
  botones de `.post-actions` van a la derecha, sin nada que enmarque el rail).
  Prueba: con `background: fuchsia` y el mismo `width:2px` se ve largo entero;
  con `--accent` se ve corto; geometría idéntica en ambos. Si algún día molesta
  de verdad, opción mínima (1 línea): en `measureRail` recortar al bottom del
  ÚLTIMO reply en vez de `rootRect.bottom` (el rail dejaría de "incluir" la
  barra, que pasa a leerse como metadatos). Por ahora se deja como está.
- **Animación de fill top-down del rail amarillo**: probada (con `paintActiveRail` JS + transition height), causaba bugs visuales de rail bleeding entre threads cuando cambiabas de activo rápido. Reemplazada por color fade instantáneo via CSS — más simple y robusto.
- **Reddit-style staircase rails** (cada rail termina al fin de su subtree, en escalera): rechazado porque el usuario prefiere uniformidad — todos los rails llegan al mismo Y (bottom de la barra).
- **`/api/me` shape changes**: el audit decía que era inconsistente, pero ya devuelve `{ authed: bool }` correcto.
- **Transcribe retry button visible**: ya está soportado implícitamente — el botón se rehabilita en error, el usuario puede hacer click otra vez.
