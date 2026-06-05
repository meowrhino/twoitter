# TODO

Lista de mejoras pendientes priorizadas por impacto vs esfuerzo. Generadas tras un deep review del proyecto (4 agentes Explore en paralelo sobre `public/js/`, `src/`, `style.css` y patrones transversales) el 2026-05-27. Lo que está marcado [done] ya está en producción.

## Pendiente

### Alta prioridad

- [ ] **Rate limiting** en `/api/upload`, `/api/posts` (POST), `/api/posts/:id/transcribe`.
  Hoy un usuario authed puede saturar la cuota de Workers AI / R2 / D1 sin freno. Como el único usuario authed es el dueño, es defensa contra accidentes (script en bucle) más que ataque.
  - **Opciones**:
    - KV namespace con sliding window per-IP y per-action (más simple).
    - Durable Object con contadores fuertemente consistentes (más correcto si hay múltiples colos involucrados).
    - Cloudflare WAF rules (zero código, configurar en dashboard).
  - **Bloqueo**: requiere crear binding nuevo en `wrangler.toml`. Decisión + setup en sesión dedicada.

- [ ] **Tests de backend** (`src/db.ts` y `src/index.ts`).
  Hoy hay tests para `src/auth.ts` y `src/media.ts` (puros), pero las queries de D1 y los endpoints HTTP están sin cubrir. Setup necesario:
  - `@cloudflare/vitest-pool-workers` para correr tests dentro de un Worker virtual con bindings mockeados.
  - Migrations corridas contra una D1 efímera por test.
  - Casos críticos a cubrir: `listPosts` paginación + filtros, `deletePost` cascada + el nonce de `deleted_at`, `restorePost` no cruza batches, CSRF rechazo, auth flow completo, `/transcribe` con audio vs sin audio.

### Media prioridad

- [ ] **Frontend tests faltantes** para `composer.js`, `pages.js`, `render.js`, `post-actions.js`.
  Hoy: `media.js`, `gallery.js`, `hidden.js`, `audio-player.js`, `tap-activate` (parte de `render.js`), `api.js`, `state.js`. Falta cubrir el flujo de publicar un post, cargar timeline, render de un thread completo, bindings de la action bar.

- [ ] **`/api/posts` POST handler** ([src/index.ts:116-167](src/index.ts)) mezcla validación, lógica y persistencia en 78 líneas.
  Partir en `validatePostBody()` (devuelve errores temprano) + `persistPost()` (db logic). Más legible y testeable individualmente.

- [ ] **Modularizar `public/style.css`** (~1400 líneas monolíticas, creció con carrete/colapso/responsive).
  División propuesta por dominio: `_colors.css`, `_typography.css`, `_layout.css`, `_post.css`, `_post-actions.css`, `_composer.css`, `_audio-player.css`, `_gallery.css`, `_menu.css`, `_toast.css`, `_login.css`, `_a11y.css`.
  Sin bundler, opción más simple: un script de build que concatene en orden, o servir varios `<link>` con `@import` (con coste de waterfall).

### Baja prioridad / quick wins

- [ ] Token `--accent-overlay-light: rgba(232, 176, 74, 0.04)` (hardcoded en hover de body y otros sitios).
- [ ] **README** con diagrama data flow (client → API → D1/R2/Workers AI), convenciones (snake_case server vs camelCase client, CSRF header `x-twoitter-csrf`, error shape `{ error: string }`), y workflow de migraciones.
- [ ] **CHANGELOG.md** o tags semver. Hoy no hay versionado de cambios de API shape.

### Bugs latentes / vulnerabilidades

- [ ] **CSRF dual-token** (defense in depth). Hoy basta el header `x-twoitter-csrf: 1`, que no es estrictamente un token — depende de SameSite=Lax cookie para prevenir cross-origin. Si en algún momento la cookie se sirviera con SameSite=None (subdomain, embed), sería bypasseable.
- [ ] **innerHTML sin escape** en `public/js/composer-poll.js` (filas de opciones) y otros templates literales. Hoy no aceptan user input, pero es frágil — si alguien interpola texto del usuario en el futuro sin escapar, XSS.
- [ ] **sessionStorage no se limpia** en `state.js` — `CSRF_HEADERS=1` se guarda siempre. No es una vuln pero queda contaminando.

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
