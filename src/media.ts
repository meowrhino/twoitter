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
  folder: "images" | "videos" | "thumbs",
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

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

export function classifyContentType(
  ct: string,
): { kind: "image" | "video"; ext: string } | null {
  if (ALLOWED_IMAGE.has(ct)) {
    const ext = ct.split("/")[1] === "jpeg" ? "jpg" : ct.split("/")[1];
    return { kind: "image", ext };
  }
  if (ALLOWED_VIDEO.has(ct)) {
    const sub = ct.split("/")[1];
    const ext = sub === "quicktime" ? "mov" : sub;
    return { kind: "video", ext };
  }
  return null;
}

export function maxBytesFor(kind: "image" | "video"): number {
  return kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
}
