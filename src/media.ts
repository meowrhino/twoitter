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
// Opus a calidad de voz ~16 KB/s → 25 MB son ~25 minutos. Workers AI Whisper
// admite hasta 25 MB en la request, así que tope coherente con eso.
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
