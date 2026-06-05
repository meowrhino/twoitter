# TODO

Lista de mejoras pendientes priorizadas por impacto vs esfuerzo. Generadas tras un deep review del proyecto (4 agentes Explore en paralelo sobre `public/js/`, `src/`, `style.css` y patrones transversales) el 2026-05-27. Lo que está marcado [done] ya está en producción.

## Pendiente

> Estado al cierre de la sesión 2026-06-05: TODO lo de valor alto/medio está
> hecho y desplegado (ver "Done" abajo). Lo que queda es lo de abajo, con mi
> recomendación honesta baked-in para retomarlo en frío.

### Lo único con valor real pendiente

- [ ] **Frontend tests del flujo CON RED** — `composer.js` (publicar un post) y
  `pages.js` (`loadTimeline` + auto-fetch del IntersectionObserver).
  **Por qué:** son los flujos cliente que más cambiaron esta sesión y los únicos
  sin cubrir. `render.js` ya está cubierto (test/render.test.ts: reply-context,
  colapso, contador, encuesta, anti-XSS) y los endpoints HTTP también
  (test/routes.test.ts vía `app.request`).
  **Cómo:** entorno happy-dom (como render.test.ts); mockear `fetch` global con
  `vi.stubGlobal('fetch', vi.fn())` que devuelva respuestas canned. Para el
  composer: montar el `<form id="composer">` mínimo, `wireComposer`, simular
  submit con texto, comprobar que `onPosted` rinde el thread. Para pages:
  montar `#timeline`, mockear `/api/posts` → `{posts, nextCursor}`, llamar
  `loadTimeline(true)`, comprobar el render por chunks + el sentinel.
  **Recomendación:** SÍ, si se quiere más cobertura. Esfuerzo medio.

- [ ] **Cobertura de backend que aún falta** (menor): el endpoint `/transcribe`
  (caching, sin-audio, fallo de Whisper, 422) y los helpers `getAudioMediaForPost`
  / `setMediaTranscript`. El resto del backend ya tiene tests (db.test.ts,
  post-handler.test.ts, routes.test.ts). El de transcribe necesita stubbear
  `c.env.AI.run` + `c.env.STORAGE.get`.

### Útil pero baja urgencia

- [ ] **Docs**: en el README, un diagrama del data-flow (cliente → API →
  D1/R2/Workers AI) + convenciones (snake_case server vs camelCase client, header
  CSRF `x-twoitter-csrf`, error shape `{ error: string }`, los 3 rate-limiters).
  Y un **CHANGELOG.md** (hoy no hay versionado de cambios de API shape).
  **Recomendación:** rápido y agradable cuando apetezca.

### Descartado a propósito (NO hacer salvo que cambie el contexto)

- [ ] ~~**Modularizar `style.css`**~~ (~1400 líneas). DESRECOMENDADO: churn +
  riesgo de romper la cascada en un archivo que funciona y está bien seccionado
  con comentarios. Sin bundler habría que montar un build que concatene en orden
  o servir varios `<link>`/`@import` (waterfall). Mal ratio valor/riesgo — misma
  conclusión que con los tokens de spacing.
- [ ] ~~**CSRF dual-token**~~. DESRECOMENDADO para esta app: un solo usuario,
  `SameSite=Lax` ya previene el cross-origin. Es endurecimiento contra un
  escenario hipotético (servir la cookie con `SameSite=None`, p.ej. embed/
  subdominio) que hoy no aplica. Reconsiderar SOLO si eso cambia.
- [ ] **sessionStorage**: `state.js` guarda `CSRF_HEADERS` siempre. Cosmético,
  no es vuln. Trivial si molesta.

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

- **Animación de fill top-down del rail amarillo**: probada (con `paintActiveRail` JS + transition height), causaba bugs visuales de rail bleeding entre threads cuando cambiabas de activo rápido. Reemplazada por color fade instantáneo via CSS — más simple y robusto.
- **Reddit-style staircase rails** (cada rail termina al fin de su subtree, en escalera): rechazado porque el usuario prefiere uniformidad — todos los rails llegan al mismo Y (bottom de la barra).
- **`/api/me` shape changes**: el audit decía que era inconsistente, pero ya devuelve `{ authed: bool }` correcto.
- **Transcribe retry button visible**: ya está soportado implícitamente — el botón se rehabilita en error, el usuario puede hacer click otra vez.
