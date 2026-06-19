// ----- recomprimir notas de voz a mono 16 kHz MP3 antes de subir -----
//
// Por qué: Safari/iOS IGNORA `audioBitsPerSecond` del MediaRecorder y graba las
// notas a ~189 kbps / 48 kHz (medido; ver recorder.js). Esto las recomprime a
// mono 16 kHz ~32 kbps MP3 — justo lo que Whisper usa internamente — dejándolas
// ~6-8× más ligeras SIN perder calidad de transcripción.
//
// TODO con red de seguridad: si algo falla (decode, OfflineAudioContext, lamejs,
// o el resultado no sale más pequeño) devolvemos null y el caller sube el
// original → nunca empeora respecto a hoy. Sólo se aplica a notas GRABADAS, no a
// audio subido a mano (que podría ser música y no queremos destrozar).

import { uuid } from './utils.js';

const TARGET_RATE = 16000;  // Hz — sample rate nativo de Whisper
const TARGET_KBPS = 32;     // mono 32 kbps: voz holgada, ~240 KB/min

// Carga perezosa de lamejs (UMD, expone window.lamejs.Mp3Encoder). El <script>
// se inyecta una sola vez; ~150 KB que sólo se descargan al grabar la 1ª nota,
// no en cada carga de página.
let lamePromise = null;
function loadLame() {
  if (window.lamejs?.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (lamePromise) return lamePromise;
  lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/lame.min.js';
    s.onload = () =>
      window.lamejs?.Mp3Encoder ? resolve(window.lamejs) : reject(new Error('lamejs sin Mp3Encoder'));
    s.onerror = () => reject(new Error('no se pudo cargar lamejs'));
    document.head.appendChild(s);
  }).catch((e) => { lamePromise = null; throw e; });
  return lamePromise;
}

// Float32 [-1,1] → Int16 PCM (lo que come lamejs).
function floatTo16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Decodifica el buffer a mono al sample rate pedido (OfflineAudioContext hace el
// downmix y el resample). Devuelve el Float32 del único canal.
async function renderMono(decoded, rate) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const offline = new OAC(1, frames, rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Recomprime un File/Blob de audio a mono 16 kHz MP3. Devuelve un File `.mp3`
// (audio/mpeg) o null si no se pudo / no compensó (→ el caller sube el original).
export async function toMonoMp3(file) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC || !OAC) return null;

    // 1. decodificar a PCM (el navegador decodifica su propio m4a/webm/opus).
    const arrBuf = await file.arrayBuffer();
    const decodeCtx = new AC();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(arrBuf.slice(0));
    } finally {
      try { decodeCtx.close(); } catch { /* algunos navegadores no lo permiten */ }
    }
    if (!decoded || !decoded.duration) return null;

    // 2. mono al rate objetivo. Safari es quisquilloso con sample rates raros en
    //    OfflineAudioContext; si 16 kHz peta, recae al rate original (sigue
    //    ganando: mono 32 kbps mp3 vs el original estéreo/alto bitrate).
    let rate = TARGET_RATE;
    let mono;
    try {
      mono = await renderMono(decoded, TARGET_RATE);
    } catch {
      rate = Math.round(decoded.sampleRate) || 48000;
      mono = await renderMono(decoded, rate);
    }
    const samples = floatTo16(mono);

    // 3. codificar MP3 (lamejs). 16 kHz → MPEG2, 48 kHz → MPEG1: ambos válidos.
    const lame = await loadLame();
    const enc = new lame.Mp3Encoder(1, rate, TARGET_KBPS);
    const chunks = [];
    const BLOCK = 1152; // tamaño de frame que espera lamejs
    for (let i = 0; i < samples.length; i += BLOCK) {
      const buf = enc.encodeBuffer(samples.subarray(i, i + BLOCK));
      if (buf.length > 0) chunks.push(buf);
    }
    const tail = enc.flush();
    if (tail.length > 0) chunks.push(tail);

    const blob = new Blob(chunks, { type: 'audio/mpeg' });
    // Sólo merece la pena si de verdad queda más ligero (notas ya minúsculas o un
    // formato muy eficiente podrían no mejorar): si no, que suba el original.
    if (blob.size === 0 || blob.size >= file.size) return null;

    return new File([blob], `nota-${uuid()}.mp3`, { type: 'audio/mpeg' });
  } catch (e) {
    console.warn('recompresión de audio falló, se sube el original', e);
    return null;
  }
}
