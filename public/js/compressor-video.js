// ----- compresión cliente: vídeo (ffmpeg.wasm VP8 720p) + thumbnail -----
//
// Política "siempre comprimir": lanza si el navegador no tiene SharedArrayBuffer
// (ffmpeg.wasm multi-thread lo requiere — ver detectCapabilities). El thumbnail
// se genera aparte con canvas, sin ffmpeg.

import { roundEvenCrop } from './editor-geom.js';

// Preset único 720p. CRF 10 con techo 2000k: VBR limitado, CRF como piso de
// calidad. Resultado típico: 1080p H.264 15Mbps → 720p VP8 ~2Mbps (-86%).
const PRESET = {
  label: '720p',
  maxBox: 1280,      // caja cuadrada → preserva orientación
  crf: 10,
  videoBitrate: '2000k',
  audioBitrate: '128k',
  cpuUsed: 4,
};

// libvorbis: libopus crashea ffmpeg.wasm (issue #591). En CLI sí va opus.
const VIDEO_CODEC = 'libvpx';
const AUDIO_CODEC = 'libvorbis';
// Bitrate del re-encode de audio al recortar una nota (fallback cuando el copy
// sin pérdida no cuadra). La fuente ya viene comprimida → 96k basta sin añadir
// artefactos. Distinto de PRESET.audioBitrate (128k, audio de vídeos) y de la
// grabación nueva (recorder.js VOICE_NOTE_BITRATE, 24 kbps Opus).
const AUDIO_TRIM_BITRATE = '96k';

const CORE_MT_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.9/dist/umd';
const WORKERFS_THRESHOLD = 200 * 1024 * 1024;

let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoading = null;

// ─── capacidades ────────────────────────────────────────────────
// Sólo el vídeo las necesita: ffmpeg.wasm multi-thread exige WebAssembly +
// SharedArrayBuffer (que a su vez requiere cross-origin isolation, ver
// coi-serviceworker.js). La imagen no pasa por aquí.

export function detectCapabilities() {
  const hasWASM = typeof WebAssembly !== 'undefined';
  const hasSAB = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
  if (!hasWASM) return { ok: false, reason: 'el navegador no soporta WebAssembly' };
  if (!hasSAB) return { ok: false, reason: 'tu navegador no permite el compresor de vídeo aquí (sin SharedArrayBuffer)' };
  return { ok: true };
}

// ─── ffmpeg loader ──────────────────────────────────────────────

async function toBlobURL(url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

export async function loadFFmpeg(onProgress) {
  if (ffmpegLoaded) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;

  const caps = detectCapabilities();
  if (!caps.ok) throw new Error(caps.reason);

  ffmpegLoading = (async () => {
    onProgress?.({ phase: 'loading', label: 'descargando ffmpeg…' });
    // FFmpegWASM lo expone /ffmpeg.js (UMD) como global window.FFmpegWASM
    const { FFmpeg } = window.FFmpegWASM;
    const f = new FFmpeg();

    const [coreURL, wasmURL, workerURL] = await Promise.all([
      toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      toBlobURL(`${CORE_MT_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
    ]);

    onProgress?.({ phase: 'loading', label: 'inicializando ffmpeg…' });
    await f.load({ coreURL, wasmURL, workerURL });
    ffmpeg = f;
    ffmpegLoaded = true;
    return ffmpeg;
  })().catch((err) => {
    ffmpegLoading = null;
    throw err;
  });

  return ffmpegLoading;
}

// ─── metadata del vídeo ─────────────────────────────────────────

function extractVideoMetadata(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      // videoWidth/Height ya considera rotación EXIF/MOV.
      const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
      URL.revokeObjectURL(v.src);
      resolve(meta);
    };
    v.onerror = () => {
      URL.revokeObjectURL(v.src);
      resolve({ duration: 0, width: 0, height: 0 });
    };
    v.src = URL.createObjectURL(file);
  });
}

// ─── construcción de argumentos ffmpeg (PURA, testeable) ────────
// Separada de compressVideo para poder testearla sin tocar el FS de ffmpeg.
//   - trim: { start, duration } en segundos → -ss/-t DESPUÉS de -i
//     (output-seeking): con re-encode es frame-accurate y no descuadra el
//     filtergraph ni el audio.
//   - crop: { x, y, w, h } en px de ORIGEN → se redondea a par (libvpx) y se
//     antepone al scale en el -vf (crop ANTES de scale).
// Sin trim ni crop, el array es idéntico al de siempre (cero regresión).
export function buildVideoArgs({ input, output, trim = null, crop = null, srcW = 0, srcH = 0, preset = PRESET }) {
  const args = ['-i', input];

  if (trim && trim.duration > 0) {
    args.push('-ss', String(trim.start), '-t', String(trim.duration));
  }

  args.push(
    '-c:v', VIDEO_CODEC,
    '-crf', String(preset.crf),
    '-b:v', preset.videoBitrate,
    '-cpu-used', String(preset.cpuUsed),
    '-lag-in-frames', '16',
    '-auto-alt-ref', '1',
    '-c:a', AUDIO_CODEC,
    '-b:a', preset.audioBitrate,
    '-threads', '2',
  );

  // Filtro que preserva orientación: encuadra en caja maxBox×maxBox respetando
  // aspect ratio, y trunca a paridad (libvpx exige par).
  const scaleFilter =
    `scale=w='min(${preset.maxBox},iw)':h='min(${preset.maxBox},ih)':force_original_aspect_ratio=decrease,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`;

  let vf = scaleFilter;
  if (crop) {
    const c = roundEvenCrop(crop, srcW, srcH);
    vf = `crop=${c.w}:${c.h}:${c.x}:${c.y},` + scaleFilter;
  }
  args.push('-vf', vf, output);
  return args;
}

// ─── "gana el más pequeño" (PURA, testeable) ────────────────────
// Reencodear a VP8 hincha los vídeos que YA venían en un códec moderno y
// eficiente (H.264/H.265 — un export de IA o un .mp4 ya optimizado): el preset
// 720p/2Mbps apunta a más bitrate que la fuente y, encima, dobla la compresión
// → archivo más pesado y peor. Si NO hubo edición (crop/trim), el original es
// web-safe y cabe en el límite y pesa menos que el WebM, mejor subir el original
// tal cual: nunca subimos algo más grande y degradado.
//   - .mov/quicktime queda FUERA a propósito: suele ser HEVC y no lo reproducen
//     Chrome/Firefox aunque el subidor (Safari) sí → mantenemos el reencode.
//   - sizeLimit falsy (aún sin cargar) no bloquea: el original es más pequeño
//     que el WebM, que ya pasa la revalidación de tamaño, así que es seguro.
export function shouldKeepOriginalVideo({ fileType, fileSize, encodedSize, sizeLimit, edited }) {
  if (edited) return false;
  if (fileType !== 'video/mp4' && fileType !== 'video/webm') return false;
  if (sizeLimit && fileSize > sizeLimit) return false;
  return fileSize < encodedSize;
}

// ─── compressVideo ──────────────────────────────────────────────

// `editParams` (opcional) puede traer { trim, crop } en unidades de ORIGEN; el
// editor de medios los produce. Sin él, comprime el vídeo entero como siempre.
// `sizeLimit` (opcional, bytes) habilita "gana el más pequeño": ver
// shouldKeepOriginalVideo.
export async function compressVideo(file, onProgress, editParams = null, sizeLimit = 0) {
  await loadFFmpeg(onProgress);
  const meta = await extractVideoMetadata(file);

  onProgress?.({ phase: 'compressing', percent: 0, label: PRESET.label });

  const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName = `input.${ext}`;
  const outputName = 'output.webm';
  const mountPoint = '/mounted';
  let usedWorkerFS = false;

  try {
    if (file.size >= WORKERFS_THRESHOLD) {
      try { await ffmpeg.unmount(mountPoint); } catch (_) {}
      try { await ffmpeg.createDir(mountPoint); } catch (_) {}
      await ffmpeg.mount('WORKERFS', { files: [file] }, mountPoint);
      usedWorkerFS = true;
    } else {
      const buf = await file.arrayBuffer();
      await ffmpeg.writeFile(inputName, new Uint8Array(buf));
    }

    const actualInput = usedWorkerFS ? `${mountPoint}/${file.name}` : inputName;

    // El editor produce el crop como { sx, sy, sw, sh } (igual que la imagen);
    // buildVideoArgs lo espera como { x, y, w, h }. Renombramos aquí.
    const ep = editParams?.crop;
    const cropArg = ep ? { x: ep.sx, y: ep.sy, w: ep.sw, h: ep.sh } : null;

    const args = buildVideoArgs({
      input: actualInput,
      output: outputName,
      trim: editParams?.trim ?? null,
      crop: cropArg,
      srcW: meta.width,
      srcH: meta.height,
      preset: PRESET,
    });

    const progressHandler = ({ progress }) => {
      const pct = Math.min(Math.round(progress * 100), 99);
      onProgress?.({ phase: 'compressing', percent: pct, label: PRESET.label });
    };
    ffmpeg.on('progress', progressHandler);

    const exitCode = await ffmpeg.exec(args);
    ffmpeg.off('progress', progressHandler);

    if (exitCode !== 0) throw new Error(`ffmpeg exit ${exitCode}`);

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data.buffer], { type: 'video/webm' });

    // "Gana el más pequeño": si el reencode quedó más pesado que el original y
    // este es web-safe + sin editar + dentro de límite, devolvemos el original
    // (con SUS dimensiones, no las del output 720p). Ver shouldKeepOriginalVideo.
    const edited = !!(editParams?.trim?.duration > 0 || editParams?.crop);
    if (shouldKeepOriginalVideo({
      fileType: file.type, fileSize: file.size, encodedSize: blob.size, sizeLimit, edited,
    })) {
      return {
        blob: file,
        width: meta.width || null,
        height: meta.height || null,
        duration: meta.duration || null,
      };
    }

    // Dimensiones reales del output (post-orientación + post-escalado)
    const outMeta = await extractVideoMetadata(blob).catch(() => ({}));
    return {
      blob,
      width: outMeta.width || null,
      height: outMeta.height || null,
      duration: meta.duration || null,
    };
  } finally {
    try {
      if (usedWorkerFS) await ffmpeg.unmount(mountPoint);
      else await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    } catch (_) {}
  }
}

// ─── thumbnail nativo (canvas) ──────────────────────────────────
// 480 lado largo, jpeg 78 → ~20KB. Suficiente para poster del <video>.

// `opts.atTime` (segundos, opcional): instante base del que sacar el poster.
// Para un clip recortado se pasa trim.start, así el poster sale de DENTRO del
// rango conservado y casa con la salida. El thumb se dibuja del File original
// (decoder canvas fiable); no aplica el crop espacial (poster de 480px, no
// compensa).
export function generateVideoThumb(file, opts = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.src = URL.createObjectURL(file);
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(v.src);
      fn(val);
    };
    const timer = setTimeout(() => finish(reject, new Error('thumb timeout')), 10_000);
    v.onloadeddata = () => {
      const base = opts.atTime != null ? opts.atTime : 0;
      v.currentTime = base + Math.min(0.5, (v.duration || 1) / 4);
    };
    v.onseeked = () => {
      const w0 = v.videoWidth || 640;
      const h0 = v.videoHeight || 360;
      const target = 480;
      const ratio = w0 > h0 ? target / w0 : target / h0;
      const w = Math.round(w0 * ratio);
      const h = Math.round(h0 * ratio);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      c.toBlob(
        (b) => finish(b ? resolve : reject, b ? { blob: b, width: w, height: h } : new Error('thumb null')),
        'image/jpeg',
        0.78,
      );
    };
    v.onerror = () => finish(reject, new Error('video load error'));
  });
}

// ─── trim de audio (ffmpeg) ─────────────────────────────────────
// Recorta una nota de voz a [start, start+duration]. Intenta primero COPIAR el
// stream sin pérdida (-c:a copy): ffmpeg.wasm NO sabe ENCODEAR opus (issue #591)
// pero sí copiarlo, así que una nota webm/ogg-opus se recorta sin recodificar —
// cero pérdida y mismo peso por segundo. Si el contenedor no admite el copy
// (mp3/m4a/wav, o si el copy descuadra), cae a re-encode libvorbis → ogg, el
// mismo códec que ya usamos para el audio de los vídeos. Requiere ffmpeg (SAB),
// igual que el vídeo; el caller sólo ofrece editar audio si hay capacidades.
export async function trimAudio(file, trim, onProgress) {
  await loadFFmpeg(onProgress);
  onProgress?.({ phase: 'compressing', percent: 0, label: 'recortando audio' });

  const ext = (file.name.split('.').pop() || 'webm').toLowerCase();
  const inputName = `audio-in.${ext}`;
  const buf = await file.arrayBuffer();

  const progressHandler = ({ progress }) => {
    const pct = Math.min(Math.round(progress * 100), 99);
    onProgress?.({ phase: 'compressing', percent: pct, label: 'recortando audio' });
  };

  // Ejecuta un intento (copy o re-encode) y limpia el FS pase lo que pase.
  const run = async (outName, codecArgs, type) => {
    await ffmpeg.writeFile(inputName, new Uint8Array(buf));
    ffmpeg.on('progress', progressHandler);
    try {
      const code = await ffmpeg.exec([
        '-ss', String(trim.start),
        '-i', inputName,
        '-t', String(trim.duration),
        '-vn',
        ...codecArgs,
        outName,
      ]);
      if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
      const data = await ffmpeg.readFile(outName);
      return new Blob([data.buffer], { type });
    } finally {
      ffmpeg.off('progress', progressHandler);
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outName).catch(() => {});
    }
  };

  // El copy sólo vale si el contenedor de salida admite el códec de origen: para
  // notas grabadas (webm/ogg) copiamos en el mismo contenedor; el resto va al
  // re-encode directo.
  if (ext === 'webm' || ext === 'ogg') {
    try {
      const blob = await run(`audio-out.${ext}`, ['-c:a', 'copy'], file.type || `audio/${ext}`);
      return { blob, width: null, height: null };
    } catch (e) {
      console.warn('audio copy-trim falló, re-encode a ogg/vorbis', e);
    }
  }
  const blob = await run('audio-out.ogg', ['-c:a', 'libvorbis', '-b:a', AUDIO_TRIM_BITRATE], 'audio/ogg');
  return { blob, width: null, height: null };
}
