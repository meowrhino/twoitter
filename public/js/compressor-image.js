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

// Dibuja el File en un canvas reescalado y devuelve { canvas, ctx, w, h }.
async function drawToCanvas(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    // navegadores antiguos sin la opción imageOrientation
    bitmap = await createImageBitmap(file);
  }
  const w0 = bitmap.width;
  const h0 = bitmap.height;
  const max = IMAGE_MAX_DIM;
  let w = w0, h = h0;
  if (w0 > max || h0 > max) {
    const r = w0 > h0 ? max / w0 : max / h0;
    w = Math.round(w0 * r);
    h = Math.round(h0 * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
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

export async function compressImage(file) {
  const { canvas, ctx, w, h } = await drawToCanvas(file);

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
