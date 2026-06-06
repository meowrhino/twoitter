// ----- compresión cliente: imagen → WebP -----
//
// Decodifica con createImageBitmap (respeta orientación EXIF), reescala el lado
// largo a IMAGE_MAX_DIM y codifica a WebP.
//
// Gotcha de iOS: WebKit (Safari y, por obligación de Apple, TAMBIÉN Brave/Chrome
// en iPhone) NO sabe codificar WebP en canvas. canvas.toBlob('image/webp')
// ignora el tipo y devuelve un PNG sin avisar → la foto sube SIN comprimir
// (un PNG de cámara pesa ~5 MB). Por eso no dependemos de toBlob: codificamos
// con un encoder WebP en WebAssembly (@jsquash/webp, el códec de Squoosh),
// que da WebP real en cualquier navegador, iOS incluido. Es single-thread →
// no necesita SharedArrayBuffer ni cross-origin isolation.
//
// Carga del WASM (la parte delicada):
//   - Importamos el módulo glue desde jsDelivr, NO esm.sh: jsDelivr manda el
//     header Cross-Origin-Resource-Policy: cross-origin, necesario porque el
//     coi-serviceworker pone COEP: require-corp en navegadores sin
//     'credentialless' (Safari/WebKit = el iPhone). esm.sh no lo manda → ahí
//     fallaría justo en iOS.
//   - Pero el bundle +esm no resuelve la ruta de su propio .wasm. Así que lo
//     hacemos a mano (igual que ffmpeg.wasm): fetch del .wasm + WebAssembly.
//     compile + init(module). Controlar la URL del .wasm es lo que hace que
//     funcione de forma fiable.
//   - Todo lazy: se carga la primera vez que se comprime una imagen.
// Si el WASM no carga (red caída, CDN bloqueado), caemos a canvas.toBlob: en
// desktop saldrá WebP igualmente; en iOS saldrá PNG, pero es mejor subir algo
// que fallar. setItemStatus muestra el formato real, así que un PNG colado se ve.

import { clamp, cropAndScaleDims } from './editor-geom.js';

const IMAGE_QUALITY = 85;          // 0..100 para jsquash (toBlob usa 0..1)
const IMAGE_MAX_DIM = 2000;

const JSQUASH_BASE = 'https://cdn.jsdelivr.net/npm/@jsquash/webp@1.5.0';
// Versión NO-SIMD: un único .wasm que funciona en todos los navegadores sin
// depender de detección de features (la SIMD daría algo más de velocidad pero
// añade una rama y otro binario; para fotos sueltas no compensa).
const GLUE_URL = `${JSQUASH_BASE}/codec/enc/webp_enc.js`;
const WASM_URL = `${JSQUASH_BASE}/codec/enc/webp_enc.wasm`;
const META_URL = `${JSQUASH_BASE}/meta.js`; // trae defaultOptions del códec

// Promesa cacheada del encoder listo (glue + wasm instanciado). Se hace una vez.
let encoderPromise = null;
function loadWebpEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      // El glue de emscripten exporta una factory por default. meta.js trae el
      // objeto completo de opciones por defecto: el encode() de bajo nivel del
      // códec EXIGE todas las opciones presentes (lanza 'Missing field:
      // "lossless"' si faltan), así que hay que mezclarlas — es lo que hace el
      // wrapper de alto nivel de @jsquash internamente.
      const [{ default: moduleFactory }, meta, wasmBuf] = await Promise.all([
        import(/* @vite-ignore */ GLUE_URL),
        import(/* @vite-ignore */ META_URL),
        fetch(WASM_URL).then((r) => {
          if (!r.ok) throw new Error(`fetch wasm → ${r.status}`);
          return r.arrayBuffer();
        }),
      ]);
      const defaultOptions = meta.defaultOptions || {};
      const wasmModule = await WebAssembly.compile(wasmBuf);
      // Instanciamos el módulo con NUESTRO binario ya compilado, sin que el glue
      // tenga que localizar el .wasm por su cuenta (que es lo que fallaba en el
      // bundle +esm).
      const mod = await moduleFactory({
        noInitialRun: true,
        instantiateWasm: (imports, cb) => {
          const instance = new WebAssembly.Instance(wasmModule, imports);
          cb(instance);
          return instance.exports;
        },
      });
      // mod.encode(rgbaData, w, h, options) → ArrayBuffer webp. options DEBE
      // llevar todos los campos → defaultOptions + nuestra quality.
      return (imageData, quality) =>
        mod.encode(imageData.data, imageData.width, imageData.height, {
          ...defaultOptions,
          quality,
        });
    })().catch((err) => {
      encoderPromise = null; // permitir reintento en la próxima imagen
      throw err;
    });
  }
  return encoderPromise;
}

// Decodifica un File a ImageBitmap respetando la orientación EXIF ('from-image'),
// con fallback a decode plano en navegadores sin esa opción. Compartido con el
// editor (editor.js) para que ambos vivan en EL MISMO espacio de píxeles — si
// divergieran, la caja de recorte se desalinearía respecto al output. Lanza si falla.
export async function decodeOrientedBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    return await createImageBitmap(file); // navegadores sin la opción imageOrientation
  }
}

// Dibuja el File en un canvas reescalado y devuelve { canvas, ctx, w, h }.
// `crop` (opcional) es un sub-rect { sx, sy, sw, sh } en píxeles del bitmap ya
// orientado — el MISMO espacio en el que el editor dibuja la caja, porque ambos
// decodifican con 'from-image'. Si no hay crop, se usa el frame entero.
async function drawToCanvas(file, crop = null) {
  const bitmap = await decodeOrientedBitmap(file);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // Sub-rect de origen: el recorte (clampado por defensa) o la imagen completa.
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (crop) {
    sx = clamp(crop.sx, 0, srcW - 1);
    sy = clamp(crop.sy, 0, srcH - 1);
    sw = clamp(crop.sw, 1, srcW - sx);
    sh = clamp(crop.sh, 1, srcH - sy);
  }

  // Escala el RECORTE (no la imagen entera) para que su lado largo ≤ IMAGE_MAX_DIM.
  const { w, h } = cropAndScaleDims(sw, sh, IMAGE_MAX_DIM);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // drawImage de 9 args: toma (sx,sy,sw,sh) del bitmap → (0,0,w,h) del canvas.
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  bitmap.close?.();
  return { canvas, ctx, w, h };
}

// Fallback: canvas.toBlob nativo (WebP en desktop; PNG en iOS, ver arriba).
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob null'))),
      type,
      quality,
    );
  });
}

// `editParams` (opcional) puede traer { crop: { sx, sy, sw, sh } } en px de
// origen — el editor lo produce; sin él, comprime la imagen entera como siempre.
export async function compressImage(file, editParams = null) {
  const { canvas, ctx, w, h } = await drawToCanvas(file, editParams?.crop ?? null);

  // Camino principal: encoder WebP en WASM → WebP real en todos los navegadores.
  try {
    const encode = await loadWebpEncoder();
    const imageData = ctx.getImageData(0, 0, w, h);
    const webpBuffer = await encode(imageData, IMAGE_QUALITY);
    if (!webpBuffer || !webpBuffer.byteLength) throw new Error('encode vacío');
    const blob = new Blob([webpBuffer], { type: 'image/webp' });
    return { blob, width: w, height: h };
  } catch (err) {
    // Red caída / CDN inaccesible: no perdemos la subida, usamos toBlob.
    console.warn('webp wasm encoder no disponible, usando canvas.toBlob', err);
    const blob = await canvasToBlob(canvas, 'image/webp', IMAGE_QUALITY / 100);
    return { blob, width: w, height: h };
  }
}
