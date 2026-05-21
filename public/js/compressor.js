// ----- compresión cliente: vídeo (ffmpeg.wasm VP8 720p) + imagen (canvas WebP) -----
//
// Política: "siempre comprimir". Vídeo lanza si el navegador no tiene SAB;
// imagen siempre va (canvas + toBlob no requieren nada especial).

// Preset único 720p, mismo que arwuchivo. CRF 10 con techo 2000k:
// VBR limitado, CRF como piso de calidad. Resultado típico:
// 1080p H.264 15Mbps → 720p VP8 ~2Mbps (-86%).
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

const CORE_MT_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.9/dist/umd';
const WORKERFS_THRESHOLD = 200 * 1024 * 1024;

const IMAGE_QUALITY = 0.85;
const IMAGE_MAX_DIM = 2000;

let ffmpeg = null;
let ffmpegLoaded = false;
let ffmpegLoading = null;

// ─── capacidades ────────────────────────────────────────────────

export function detectCapabilities() {
  const hasWASM = typeof WebAssembly !== 'undefined';
  const hasSAB = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
  if (!hasWASM) return { ok: false, reason: 'el navegador no soporta WebAssembly' };
  if (!hasSAB) return { ok: false, reason: 'recarga la página una vez para activar el compresor' };
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

// ─── compressVideo ──────────────────────────────────────────────

export async function compressVideo(file, onProgress) {
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

    // Filtro que preserva orientación: encuadra en caja maxBox×maxBox
    // respetando aspect ratio, y trunca a paridad (libvpx exige par).
    const scaleFilter =
      `scale=w='min(${PRESET.maxBox},iw)':h='min(${PRESET.maxBox},ih)':force_original_aspect_ratio=decrease,` +
      `scale=trunc(iw/2)*2:trunc(ih/2)*2`;

    const args = [
      '-i', actualInput,
      '-c:v', VIDEO_CODEC,
      '-crf', String(PRESET.crf),
      '-b:v', PRESET.videoBitrate,
      '-cpu-used', String(PRESET.cpuUsed),
      '-lag-in-frames', '16',
      '-auto-alt-ref', '1',
      '-c:a', AUDIO_CODEC,
      '-b:a', PRESET.audioBitrate,
      '-threads', '2',
      '-vf', scaleFilter,
      outputName,
    ];

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

export function generateVideoThumb(file) {
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
      v.currentTime = Math.min(0.5, (v.duration || 1) / 4);
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

// ─── compressImage ──────────────────────────────────────────────
// canvas.toBlob('image/webp', 0.85) + resize a IMAGE_MAX_DIM en el lado largo.
// createImageBitmap con imageOrientation='from-image' respeta EXIF rotation.

export async function compressImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    // navegadores antiguos sin imageOrientation
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
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob null'))),
      'image/webp',
      IMAGE_QUALITY,
    );
  });
  return { blob, width: w, height: h };
}
