// ----- compresión cliente: barril -----
//
// La compresión vive en dos módulos por tipo de medio, que tienen poco que
// ver entre sí (ffmpeg.wasm + SharedArrayBuffer para vídeo; canvas a secas
// para imagen). Este archivo reexporta la API pública para que el resto del
// front (media.js) importe desde un único sitio.
//
//   compressor-video.js → detectCapabilities, loadFFmpeg, compressVideo,
//                         generateVideoThumb, trimAudio
//   compressor-image.js → compressImage

export {
  detectCapabilities,
  loadFFmpeg,
  compressVideo,
  generateVideoThumb,
  trimAudio,
} from './compressor-video.js';
export { compressImage } from './compressor-image.js';
