function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function randomKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildMediaKey(
  folder: "images" | "videos" | "audios" | "thumbs",
  ext: string,
): string {
  const d = new Date();
  const yy = pad2(d.getFullYear() % 100);
  const mm = pad2(d.getMonth() + 1);
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return `${folder}/${yy}/${mm}/${randomKey()}.${safeExt}`;
}

const ALLOWED_IMAGE = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const ALLOWED_VIDEO = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
// Notas de voz: webm/opus de MediaRecorder + mp3/m4a/ogg para archivos
// subidos manualmente (un memo de iOS llega como audio/mp4).
const ALLOWED_AUDIO = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
]);

// Tras la compresión cliente (WebP 0.85 / VP8 720p) estos límites sobran.
// Si llega algo más grande es señal de que la compresión no se aplicó.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50 MB
// 25 MB = lo que admite Workers AI Whisper por request, así que el tope cuadra
// con eso. Holgadísimo para voz: nuestras notas son opus 24 kbps mono (~3 KB/s,
// ver recorder.js) → horas; aun si entra un audio subido más denso, 25 MB sobran.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function classifyContentType(
  ct: string,
): { kind: "image" | "video" | "audio"; ext: string } | null {
  if (ALLOWED_IMAGE.has(ct)) {
    const ext = ct.split("/")[1] === "jpeg" ? "jpg" : ct.split("/")[1];
    return { kind: "image", ext };
  }
  if (ALLOWED_VIDEO.has(ct)) {
    const sub = ct.split("/")[1];
    const ext = sub === "quicktime" ? "mov" : sub;
    return { kind: "video", ext };
  }
  if (ALLOWED_AUDIO.has(ct)) {
    const sub = ct.split("/")[1];
    // mapeos pragmáticos: mp4/x-m4a → m4a, mpeg → mp3, x-wav → wav
    const ext =
      sub === "mpeg" ? "mp3"
      : sub === "mp4" || sub === "x-m4a" ? "m4a"
      : sub === "x-wav" ? "wav"
      : sub;
    return { kind: "audio", ext };
  }
  return null;
}

export function maxBytesFor(kind: "image" | "video" | "audio"): number {
  if (kind === "image") return MAX_IMAGE_BYTES;
  if (kind === "audio") return MAX_AUDIO_BYTES;
  return MAX_VIDEO_BYTES;
}

// Convierte un Uint8Array a string base64. Workers AI Whisper espera el
// audio como base64 string. La técnica de String.fromCharCode.apply puede
// reventar el stack con buffers grandes (> ~64KB de args en algunas runtimes);
// chunkear es la única forma fiable. CHUNK 0x8000 (32 KB) es seguro en todos
// los runtimes que hemos probado y es ~30x más rápido que un loop byte a byte.
export function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, u8.length);
    // subarray no copia; el cast es seguro porque apply acepta array-like
    // (typed arrays son array-like válidos para apply en spec ES2015+).
    binary += String.fromCharCode.apply(
      null,
      u8.subarray(i, end) as unknown as number[],
    );
  }
  return btoa(binary);
}
