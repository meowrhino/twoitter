# Handoff — editor de medios (en curso) + verificación de la revisión de código

Fecha: 2026-06-05. Punto de entrada para retomar en una sesión nueva: qué se hizo,
qué falta, y un prompt listo para verificar de forma independiente los hallazgos de
una revisión de código (descartando falsos positivos).

---

## 1. Estado actual

### Feature en curso: editor de medios en cliente (opción ③)
Recortar adjuntos del composer antes de publicar: **imagen** (crop), **vídeo**
(trim de duración + crop de encuadre), **audio** (trim). Hand-rolled, sin deps de
UI (coherente con el repo). Plan completo en
`~/.claude/plans/giggly-mixing-spindle.md`.

**Hecho y desplegado** (en `twoitter.meowrhino.studio`):
- **F0** `public/js/editor-geom.js` — math pura (solveCropConstraints, computeDisplayBox,
  cropSourceRect, roundEvenCrop, cropAndScaleDims, pxToTime) + `test/editor-geom.test.ts` (26 tests).
- **F1** plumbing del compresor — `compressImage(file, editParams)` con crop;
  `buildVideoArgs` (trim `-ss/-t` output-seeking + `crop=` antes de `scale`, dims pares);
  `generateVideoThumb({atTime})`; `trimAudio` (`-c:a copy` sin pérdida, fallback libvorbis/ogg).
  `test/compressor-args.test.ts` (incl. caso "sin trim/crop == array de hoy" = cero regresión).
- **F2** seam en `public/js/media.js` — `runCompression` (compartido), `reprocessItem`,
  `updatePreviewMedia`, campos `editParams`/`editedPreviewUrl`, botón `.edit` (audio sólo con
  caps ffmpeg), revoke lifecycle + evento `twoitter:item-removed`. Tests ampliados.
- **F3** `public/js/editor-cropbox.js` — caja libre: 8 tiradores + cuerpo, pointer events con
  setPointerCapture, `touch-action:none`, rect en fracción (sobrevive resizes), dibujar caja nueva.
- **F5** `public/js/editor.js` — modal singleton (clon del lightbox: role=dialog, focus-trap, Esc,
  backdrop, body.editor-open) + `setupEditor()` en `public/app.js` + CSS en `public/style.css`.
  **Camino IMAGEN end-to-end.** Vídeo/audio muestran "próximamente".
- Aparte: `perf(recorder)` notas de voz a **24 kbps mono**; `fix(css)` fondo anclado al viewport
  vía `body::before` (bug iOS WebKit con `background-attachment: fixed`).

**Pendiente:**
- **F4** `editor-trimtrack.js` (pista de trim, genérica vídeo/audio) — aún no creado.
- **F6** vídeo en el modal (trim + crop) → deploy.
- **F7** audio en el modal (trim) → deploy.

**Nota:** por eso `editor.js` y `media.js` tienen HOOKS hacia vídeo/audio aún inalcanzables
(p.ej. ramas vídeo/trim en `applyEdit`, `ctx.urls`). No son bugs sueltos: son andamiaje de F6/F7.

### A verificar en dispositivo real (el preview MCP es headless: ni pointer ni ffmpeg)
- Recorte de imagen: arrastre/EXIF (que el recorte case con la foto)/táctil (no scrollee).
- Fondo iOS arreglado (textura quieta al hacer scroll en Brave/iPhone).

---

## 2. Veredicto VERIFICADO de la revisión de código (leído contra el código real)

Una revisión automática produjo ~15 hallazgos. Verificación hecha en esta sesión:

- **Reales y accionables:** `ctx.urls` muerto (editor.js:188, nunca se hace push); ramas vídeo/trim
  inalcanzables en `applyEdit` (necesitan comentario); duplicación factual de animación de altura
  (4 helpers rails.js + composer-anim.js) y de `trapTab`/modal (gallery↔editor); README:93 stale
  ("opus ~16 KB/s" → ahora 24 kbps mono) + no menciona el editor.
- **EXAGERADO (medio falso positivo):** el "bug" de `focusPostFromHash` (render.js) — el agente dijo
  que falta el botón ocultar **Y** el stagger de botones. El stagger **NO** falta: `syncThreadActiveFlags`
  llama a `staggerActionButtons` (render.js:280) y lo invocan las dos rutas. Lo único que falta de
  verdad frente a la ruta de click es `refreshThreadHideBtn(el)` en render.js:234 → bug real pero de
  UNA línea (post llegado por /#id puede mostrar "ocultar" en vez de "desocultar").
- **FALSO POSITIVO:** even-rounding/off-by-one en `compressor-image` `drawToCanvas` — NO es bug:
  clampa sx→srcW-1 y sw→srcW-sx (drawImage no se sale del bitmap) y WebP no necesita dims pares.
- **Opiniones (refactor válido, NO bugs):** split de media.js / rails.js / db.ts, sacar polls de
  render.js, const compartida de bitrate, dedups menores. Son juicios de modularización.

---

## 3. Prompt para verificación INDEPENDIENTE (3 opciones + recomendación + por qué por cambio)

Pegar tal cual en una sesión nueva de Claude Code en este repo:

```text
Eres un revisor escéptico del repo "twoitter" (este working directory). Stack: Cloudflare
Workers + Hono + D1 + R2 + Workers AI. Frontend vanilla ES modules en public/js (sin framework;
solo WASM de códecs desde CDN), muy comentado en español, disciplina "un módulo = una
responsabilidad". Backend TypeScript en src/. Tests vitest en test/ (`npm test`).

CONTEXTO: se está construyendo por fases un EDITOR DE MEDIOS en cliente. Hechas y desplegadas:
F0 editor-geom.js (math pura + tests), F1 plumbing del compresor (buildVideoArgs/trimAudio en
compressor-video.js, crop en compressor-image.js), F2 seam en media.js (reprocessItem/
runCompression/updatePreviewMedia + botón .edit), F3 editor-cropbox.js, F5 editor.js (modal,
SOLO imagen). PENDIENTES: F6 (vídeo trim+crop) y F7 (audio trim) — por eso editor.js y media.js
tienen HOOKS hacia vídeo/audio que aún no son alcanzables. Plan en
~/.claude/plans/giggly-mixing-spindle.md.

TAREA: una revisión automática previa produjo los hallazgos de abajo. Verifícalos de forma
INDEPENDIENTE leyendo el código real — sé ADVERSARIO: asume que cada uno puede ser un falso
positivo o estar exagerado hasta que lo demuestres citando el código. NO modifiques ningún
archivo (solo lectura + informe). Puedes leer el plan y correr `npm test`.

Para CADA hallazgo entrega:
- VEREDICTO: CONFIRMADO (bug) / EXAGERADO (verdad a medias) / OPINIÓN (refactor válido, no bug)
  / FALSO POSITIVO — con la EVIDENCIA: cita el código exacto + file:line que lo prueba.
- 3 OPCIONES de qué hacer (p.ej. arreglo mínimo / refactor limpio / dejarlo), cada una con su
  trade-off (corrección, riesgo de tocar código que funciona, esfuerzo, y timing respecto a
  F6/F7 que están en marcha).
- RECOMENDACIÓN + POR QUÉ.

TRAMPAS en las que la revisión previa pudo caer (verifícalas con especial cuidado):
- "Bug de focusPostFromHash": comprueba si syncThreadActiveFlags (render.js) ya llama a
  staggerActionButtons; si es así, lo de "no se aplica el stagger" es FALSO y lo único que
  falta de verdad frente a la ruta de click (bindPostClickToNavigate) es refreshThreadHideBtn.
  Di exactamente qué falta y qué no.
- "Even-rounding/off-by-one en compressor-image": comprueba si drawToCanvas clampa el sub-rect
  (sx→srcW-1, sw→srcW-sx) de modo que drawImage NUNCA exceda el bitmap, y si WebP necesita dims
  pares. Decide si hay algún bug real (probablemente no).
- Distingue BUGS reales de REFACTORS de juicio (partir un archivo, extraer un helper): etiqueta
  los segundos como OPINIÓN, no error.
- Refactors de código vivo y testeado (splits de rails.js/media.js, extraer animateHeight/
  createModal) tienen riesgo real y pueden chocar con F6/F7 en curso: mete el timing en la
  recomendación.

HALLAZGOS A VERIFICAR:
[ALTA]
1. render.js ~219-235 focusPostFromHash (activación por hash/deep-link) no refresca el estado de
   botones que sí hace la ruta de click bindPostClickToNavigate ~174-179. Afirmación: el post al
   que llegas por /#id muestra mal ocultar/desocultar Y mal la cascada (stagger). Verifica QUÉ
   falta exactamente.
2. media.js (454 líneas) mezcla 4 conceptos (transporte de subida, orquestación de compresión,
   DOM de preview, pipeline de submit). Afirmación: sacar preview-item.js (createPreviewItem/
   setItemStatus/updatePreviewMedia).
3. rails.js (468) junta dos subsistemas: animación del acordeón de respuestas (~35-167) y la
   geometría/observer del rail activo (~232-468). Afirmación: separar el acordeón.
4. Patrón de animación de altura duplicado en rails.js (animateRepliesOpen/Close ~66-126) y
   composer-anim.js (animateComposerOpen/Close ~39-75): mismo lockstepRail + WAAPI + guard
   fired/settled + setTimeout(MS+120) de fallback para pestañas en background. Afirmación:
   extraer animateHeight() compartido.
[MEDIA]
5. gallery.js renderLightbox (~302-339) y swapStage (~188-258) son el mismo FLIP-crossfade con
   preload y race-guard escrito dos veces. Afirmación: extraer crossfadeSwap().
6. Modal + focus-trap duplicado entre gallery.js (lightbox ~270-288 + trapTab ~454-473) y
   editor.js (~26-51 + trapTab ~211-229). Afirmación: extraer createModal()/trapTab compartido
   (relevante ANTES de F6, que añade otro modal).
7. render.js también es dueño del UI de encuestas (renderPoll ~72-107, bindPollActions ~114-147),
   ajeno a hilos/activación. Afirmación: separar módulo de render de polls.
8. compressor-image.js drawToCanvas (~92-123) no redondea el crop a par y podría tener drift de
   1px en el origen. Afirmación: posible draw fuera de límites/replicado. (sospechoso de FP)
9. editor.js applyEdit (~154-163) tiene ramas vídeo/trim, pero openEditor (~123-130) rechaza todo
   lo no-imagen → inalcanzables hoy. Afirmación: código especulativo, necesita comentario.
10. editor.js:188 `for (const u of ctx.urls || [])` itera ctx.urls, inicializado [] en el único
    call site (~251) y sin ningún push → no-op permanente. Afirmación: limpieza muerta; quitar o
    cablear (F6 vídeo necesitará trackear blob URLs).
11. El bitrate de audio aparece como 3 constantes sueltas: 24 kbps (recorder.js nota de voz),
    128k (compressor-video.js PRESET.audioBitrate), 96k (trimAudio re-encode). Afirmación:
    riesgo de drift, ¿const compartida?
12. src/db.ts attachMediaAndTags (~95-255): una función de ~160 líneas con 7 queries en paralelo
    + 7 bucles de ensamblado + resolución de parent-excerpt. Afirmación: extraer assemblePolls/
    resolveParentExcerpts.
[BAJA]
13. prefers-reduced-motion se lee de 3 formas (rails.js ~55-58, gallery.js ~24-25, composer-anim
    ~15-17). Afirmación: un prefersReducedMotion() en utils.js.
14. README.md:93 dice "opus pesa ~16 KB/s, no recomprimimos" — stale: recorder.js ahora graba Opus
    a 24 kbps mono explícito. Y README (features/estructura) no menciona el editor de medios.
15. Dedups menores: mediaKindOf(file) (chequeo de tipo en media.js/composer.js), nextFrame/wait
    (gallery.js, pages.js) → utils.js; src/index.ts ~462-469 mapa kind→folder duplica
    media.js ~60-61.

SALIDA: un informe estructurado, una sección por hallazgo (Veredicto + evidencia + 3 opciones +
recomendación + por qué). Empieza con un recuento de 1 línea (cuántos CONFIRMADOS vs OPINIONES vs
FALSOS POSITIVOS). Termina con un ORDEN recomendado de ejecución (qué hacer ahora vs después de
F6/F7), justificado.
```
