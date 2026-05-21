# Handoff: integración de compresión cliente

> Archivo temporal de traspaso para una deep repo review en otra conversación.
> Borra cuando ya no haga falta.

## TL;DR

Se ha integrado compresión cliente para vídeo (ffmpeg.wasm → WebM VP8 720p) e
imagen (canvas → WebP 0.85). Patrón calcado de `arwuchivo` (mismo stack
Cloudflare Workers + R2, mismo preset). Antes del cambio twoitter subía
los archivos en crudo: el `.mov` del post 23 son 78 MB; con el nuevo flujo
ese mismo vídeo pesaría ~11 MB (-86%).

Política acordada con el usuario: **siempre comprimir** (vídeo lanza si no
hay SAB), **siempre WebP 0.85** para imágenes.

## Archivos nuevos

| Archivo | Origen | Qué hace |
|---|---|---|
| `public/coi-serviceworker.js` | copiado de `arwuchivo` | Service worker que añade COOP/COEP a las responses en runtime → habilita `SharedArrayBuffer` → permite ffmpeg.wasm multi-thread. La primera carga instala el SW y recarga la página automáticamente. |
| `public/ffmpeg.js` | copiado de `arwuchivo` | Loader UMD de `@ffmpeg/ffmpeg`. Expone `window.FFmpegWASM`. Cargado como script clásico en `<head>`. |
| `public/814.ffmpeg.js` | copiado de `videoToWeb` | Chunk worker que `ffmpeg.js` carga dinámicamente (resuelto vía publicPath relativo a su propia URL). |
| `public/js/compressor.js` | nuevo | Módulo ES. Exporta `compressVideo`, `compressImage`, `generateVideoThumb`, `loadFFmpeg`, `detectCapabilities`. |

## Archivos modificados

| Archivo | Cambio |
|---|---|
| `public/js/media.js` | Reescrito el flujo de `attachFile` y `uploadPendingFiles`. La compresión arranca en background al adjuntar (para aprovechar el tiempo que el usuario tarda escribiendo). `uploadPendingFiles` espera a la promesa antes de subir el blob comprimido + thumbnail. `setItemStatus` ampliado con estados `compressing`/`compressed`. |
| `public/index.html` | Añadidos `<script src="/coi-serviceworker.js">` en `<head>` y `<script src="/ffmpeg.js">` antes del module `app.js`. |
| `public/post.html` | Idem. |
| `src/media.ts` | `MAX_IMAGE_BYTES` 20 MB → 10 MB, `MAX_VIDEO_BYTES` 200 MB → 50 MB. Con compresión activa sobra. |

## Preset usado (VP8 720p, mismo que arwuchivo)

```
-c:v libvpx -crf 10 -b:v 2000k -cpu-used 4
-lag-in-frames 16 -auto-alt-ref 1
-c:a libvorbis -b:a 128k -threads 2
-vf "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,
     scale=trunc(iw/2)*2:trunc(ih/2)*2"
```

Decisiones clave del preset:
- **VP8 (no VP9)**: VP9 causa OOM en ffmpeg.wasm. Issue conocido.
- **libvorbis (no libopus)**: libopus causa stack overflow en ffmpeg.wasm. En CLI nativo sí iría opus.
- **Filtro de escala con `force_original_aspect_ratio=decrease`**: encuadra en caja 1280×1280 manteniendo el aspect ratio, **respeta orientación vertical/horizontal**. Crítico: el primer intento usaba `scale=1280:720` y aplastaba vídeos verticales de iPhone (el usuario lo pilló mirando una prueba).
- **`scale=trunc(iw/2)*2:trunc(ih/2)*2`** detrás: libvpx exige dimensiones pares.
- **CRF 10 + bitrate techo 2000k**: VBR limitado, CRF como piso de calidad. Resultado típico 1080p H.264 15Mbps → 720p VP8 ~2Mbps.

## Imágenes

`createImageBitmap(file, { imageOrientation: 'from-image' })` para respetar
EXIF rotation (las fotos de iPhone marcan rotación en metadata, no en píxeles).
Resize a 2000px lado largo, `canvas.toBlob('image/webp', 0.85)`.

## Cambios en paralelo del usuario (mientras yo trabajaba)

Mientras la sesión hacía la integración, el usuario refactorizó por su
cuenta (o un linter/hook) cosas ortogonales. **No conflictan** con la
compresión, pero conviene revisar que todo encaja:

- `public/app.js` → de monolito a entry point ES que importa los módulos en `public/js/`
- `public/js/*.js` → 10 módulos ES nuevos (auth, composer, hashtags, media, menu, pages, rails, render, state, utils)
- `public/js/render.js` → `post-actions` movido fuera de `.post-body`, ahora hijo directo del `<article.post>`, posicionado con CSS absoluto vs `--rail-bottom`
- `public/login.html` y nuevo `public/aviso-legal.html` → footer con link al aviso legal
- `package.json` → añadido `vitest` y scripts `test`/`test:watch`
- `test/` → nuevo directorio con `auth.test.ts`, `hashtags.test.ts`, `media.test.ts` (server-side, no toca el flujo cliente)

## Verificación que ya se hizo

- ✅ `wrangler dev` arranca local sin error
- ✅ `/`, `/coi-serviceworker.js`, `/ffmpeg.js`, `/js/compressor.js` → 200
- ✅ Test offline de la conversión con ffmpeg CLI sobre el `.mov` real del post 23:
  - Original 78 MB / 1920×1080 H.264 a 15 Mbps / 43s
  - WebM VP8 720p (preset arwuchivo): **11 MB (-86%)** — 720×1280 vertical preservado
  - MP4 H.264 720p (CRF 24 slow, fuera de scope): 7.6 MB (-90%) — descartado porque libx264 no está en `@ffmpeg/core-mt` por GPL
- ⚠️ **No se ha probado el flujo end-to-end en navegador** (cargar ffmpeg.wasm + comprimir + subir). El usuario tiene que abrir localhost y probar.

## Lo que falta por hacer

### 1. Probar en navegador (el usuario)
- `npm run dev`, abrir http://localhost:8787, ver que la primera carga instala coi-serviceworker y recarga
- Loguear, pegar/adjuntar un vídeo, ver que aparece `comprimiendo N%` y luego el peso final
- Comprobar que el upload va y el post se renderiza con poster + reproduce bien

### 2. Reencodear los vídeos viejos ya subidos
El post 23 (y cualquier otro vídeo subido antes del cambio) sigue siendo el
`.mov` 78 MB original. Hay que escribir un script local que:
1. Liste los `.mov` / `.mp4` grandes en R2 (`wrangler r2 object list twoitter-storage`)
2. Para cada uno: descargar (`wrangler r2 object get`), comprimir con ffmpeg
   local con el mismo preset (CRF 10, b:v 2000k, scale box 1280), generar thumbnail
3. Subir el `.webm` con un `r2_key` nuevo (`videos/YY/MM/random.webm`), subir thumb (`thumbs/...`)
4. Actualizar la fila correspondiente en D1: `UPDATE media SET r2_key=?, thumb_key=? WHERE r2_key=?`
5. Borrar el `.mov` viejo de R2

Listo para hacer cuando el usuario dé el OK.

### 3. (Opcional) Cancelación al quitar un item mientras comprime
Ahora mismo, si el usuario adjunta un vídeo y le da a la × mientras está
comprimiendo, el item se quita del `pending` Map pero la promesa de
`ffmpeg.exec` sigue consumiendo CPU/memoria en background hasta terminar.
Arreglo: guardar un AbortController por item y llamar `ffmpeg.terminate()`
(equivalente a abort) si se quita mientras está en `compressing`. No
bloqueante, pero molesto si se cancela un vídeo grande.

### 4. (Opcional) Warning visible si no hay SAB
La detección de capacidades existe (`detectCapabilities()`), pero solo se
ejecuta cuando se intenta cargar ffmpeg. Si el usuario adjunta un vídeo y
el navegador no tiene SAB (primer load antes del SW reload), el error
aparece tarde. Mejora: mostrar un banner persistente al cargar la app si
`!self.crossOriginIsolated`.

### 5. (Opcional) WakeLock durante compresión larga
Arwuchivo usa `navigator.wakeLock.request('screen')` para que la pantalla
no se duerma durante una compresión de varios minutos. No lo importé.
Decidir si tiene sentido para uploads más cortos de twoitter.

### 6. (Opcional) HEIC support
`createImageBitmap` no decodea HEIC en navegadores no-Safari. Si el usuario
arrastra una `.heic` desde Mac (no desde iPhone), fallará la compresión.
Solución: `heic2any` (CDN, ~250 KB) cargado lazy solo si detectamos HEIC.

## Riesgos a revisar en la deep repo review

1. **`composer.js` → submit**: el botón "publicar" aparece habilitado
   incluso si la compresión todavía está en marcha. El click funciona
   (await dentro de `uploadPendingFiles` espera la promesa), pero la UX
   puede ser confusa porque el usuario pulsa y aparenta no pasar nada.
   Mejora simple: si algún item está `compressing`, desactivar el botón
   y mostrar "comprimiendo…".

2. **`media.js` → `pending.set(localId, { ...item, ...meta, status: 'ready' })`**:
   el spread crea un objeto nuevo, así que mutaciones posteriores sobre
   `item` (que aún tiene referencias en otros sitios?) no se propagan.
   Repasar si hay alguna referencia retenida.

3. **`uploadPendingFiles` lanza el error tal cual**: si una compresión
   falla, el bucle aborta y los items posteriores (que sí tenían
   `compressed`) se quedan sin subir. ¿Política deseada? Quizá saltarse
   los fallidos y subir el resto.

4. **`compressor.js` → `ffmpegLoading` no se resetea si el `await` interno
   lanza**: la cadena `.catch` lo limpia, pero si `loadFFmpeg` se invoca
   en paralelo entre el throw y el catch hay una mini race. No es crítico
   porque la siguiente llamada lo reintenta.

5. **`src/media.ts` MAX_VIDEO_BYTES = 50 MB**: si el cliente NO comprime
   (porque SAB no funciona y el usuario ignora el error), un vídeo grande
   raw choca con el límite. Igual que antes el límite era 200 MB pero
   tampoco se comprimía. Decidir si es aceptable.

6. **TypeScript pre-existente roto**: `npx tsc --noEmit` ya daba 2 errores
   antes de los cambios (en `src/index.ts`). No los toqué.

7. **El refactor a módulos ES de `app.js` no está commiteado todavía**.
   `public/js/` está untracked en git. Esto se mezcla en el mismo commit
   que los cambios de compresión. Conviene separar en dos commits.

## Cómo verificar lo de la compresión sin Chrome

Si la review quiere reproducir sin abrir navegador:

```bash
# Bajar el video del post 23
curl -o /tmp/post23.mov https://twoitter.meowrhino.studio/r2/videos/26/05/a8c15ebb808850f006c5b7e3.mov

# Aplicar el mismo preset (libopus en CLI, libvorbis en WASM, equivalente)
ffmpeg -i /tmp/post23.mov \
  -c:v libvpx -crf 10 -b:v 2000k -cpu-used 4 \
  -lag-in-frames 16 -auto-alt-ref 1 \
  -c:a libopus -b:a 128k -threads 4 \
  -vf "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  /tmp/post23.webm

ls -lh /tmp/post23.*
# Debe quedar el .webm a ~11 MB
```

## Carpeta de archivos de prueba

`~/Documents/twoitter-compresion-test/` contiene:
- `original.mov` — 78 MB (descargado del post 23)
- `arwuchivo_preset.webm` — 11 MB (preset elegido)
- `h264_720p.mp4` — 7.6 MB (alternativa H.264 descartada)

El usuario los validó visualmente. Borrar cuando ya no haga falta.
