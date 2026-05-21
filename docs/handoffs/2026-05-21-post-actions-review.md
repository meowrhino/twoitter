# Handoff para deep repo review

Doc temporal — borrar tras revisar. Conversación previa cerrada; este archivo es el contexto que necesita el siguiente Claude para retomar.

## Último cambio sobre el que pivoteamos

Mover `responder/borrar` **fuera del `.post-body`**, anclado a la derecha del `.post`, alineado verticalmente con el final del rail (`--rail-bottom` que mantiene `extendRails`). Siempre visible (no hover-gated). Aplicado en home y `/post/:id`.

- **Commiteado** en `c68e11e` (junto con tests): cambios en `public/js/render.js`.
- **Sin commitear** en working tree: `public/style.css` (nueva regla `.post-actions { position: absolute; right: 0; bottom: var(--rail-bottom, 0); … }` + limpieza de los hacks anteriores: `padding-bottom: 28px`, `opacity:0` hover-show, override `@media (hover: none)`, `.post.clickable > .post-body { position: relative }`).

## Cosas a verificar en el review

1. **Overlap en hilos anidados**: el rail del padre termina exactamente donde acaba el último descendiente. Su `[responder borrar]` y el del último hijo caen al mismo X,Y. Posibles fixes: escalonar por profundidad (`bottom: calc(var(--rail-bottom, 0) + var(--depth) * 1.4em)`), o mover los del padre fuera del eje del último hijo.
2. **Overlap con `.reply-inline`** abierto en un post sin descendientes: el composer ocupa flow, los botones quedan absolutos en `bottom:0` del `.post` (debajo del card del composer, en el padding). Verificar visualmente que no se solapan con el composer.
3. **Post principal de `/post/:id`** (sin rail, `::before { display:none }`): `--rail-bottom` no se setea → fallback `bottom: 0` del CSS. Los botones caen en la esquina inferior derecha del post protagonista. Comprobar que se ve OK con su `padding: 24px 4px 28px 16px`.
4. **Orphan CSS**: la regla `.post-foot .grow { flex: 1 }` quedó huérfana (el `<span class="grow">` se eliminó del foot). Inofensiva pero borrable.
5. **`bindPostClickToNavigate`** ([public/js/render.js:50](public/js/render.js:50)): el check `e.target.closest('a, button, video, .composer')` sigue cubriendo los nuevos botones (son `<button>` directos hijos de `.post`, no de `.post-body`). Verificar que click en "responder/borrar" no navega al permalink.

## Cosas que cambiaron en paralelo (mientras yo iteraba)

El usuario hizo dos commits grandes que no vi venir hasta el final — vale la pena un repaso completo:

- **`a06035b` refactor a 10 módulos ES** (`public/js/*.js`): `app.js` pasó de monolítico a `state/utils/auth/menu/composer/media/render/rails/hashtags/pages`. Revisar:
  - dependencias circulares entre módulos
  - exports/imports consistentes (¿algún símbolo dead?)
  - el flujo `composerState` (WeakMap) sigue intacto entre `composer.js` y `media.js`
- **`c68e11e` tests con vitest** (`test/*.test.ts`, 31 passing): cubre `hashtags`, `media`, `auth` del backend. Revisar:
  - ¿hay regresiones en `src/` que los tests no cubren? (db.ts, index.ts sin tests)
  - ¿conviene añadir tests del frontend? (render.js, rails.js son los más testeables — funciones puras)
- **`public/js/compressor.js`** (262 líneas): compresión cliente (ffmpeg.wasm VP8 720p para vídeo + canvas WebP para imagen). No lo había visto. Revisar integración con `media.js` y `composer.js`, fallback si no hay SAB, tamaños finales, UX en errores.

## Pendientes funcionales (UI) que dejamos sin tocar

1. **Decidir overlap rail+botones** (punto 1 de arriba).
2. **Commit del `style.css`** actual cuando confirmemos que se ve bien (el usuario commitea manualmente).

## Pendientes técnicos sugeridos para la review

- Pasar `npm test` y confirmar que sigue verde tras el refactor.
- Revisar consistencia entre `auth.ts`/`auth.js` (backend/frontend comparten nombre, no código).
- `compressor.js` no tiene tests — y es el módulo con más riesgo (ffmpeg.wasm, SAB, COOP/COEP headers).
- `hashtags.ts` (backend) vs `hashtags.test.ts`: confirmar que el test importa la implementación real, no una copia.
- ¿`schema.sql` sigue alineado con lo que asume `db.ts` tras todo el churn?

## Cómo arrancar la review

```bash
git status                          # ver style.css sin commitear
git log --oneline -15               # contexto reciente
npm test                            # 31 tests deberían pasar
npm run dev                         # smoke test visual en localhost
```

Luego abrir este archivo y atacar la lista de "cosas a verificar" + "pendientes".
