import { Hono } from "hono";
import {
  isAuthed,
  requireAuth,
  setAuthCookie,
  clearAuthCookie,
  timingSafeEqual,
} from "./auth";
import type { Context, Next } from "hono";
import {
  attachMedia,
  createPost,
  deletePost,
  exportAll,
  getAudioMediaForPost,
  getPost,
  getReplies,
  listHashtags,
  listPosts,
  restorePost,
  setMediaTranscript,
} from "./db";
import { syncHashtags } from "./hashtags";
import {
  buildMediaKey,
  classifyContentType,
  maxBytesFor,
} from "./media";

// ---------- config ----------

// Idioma forzado para Whisper. Las notas de voz del usuario son en castellano,
// y fijarlo evita ~5% de errores donde el detector automático confunde
// audios cortos con portugués o italiano. Para reactivar auto-detect, poner
// null y el endpoint omitirá el campo `language` en la llamada al modelo.
const WHISPER_LANGUAGE: string | null = "es";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

type Bindings = {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  PASSWORD: string;
  AUTH_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  console.error("worker error:", err?.message, err?.stack);
  return c.json({ error: "internal" }, 500);
});

// CSRF: writes require a custom header that HTML forms cannot set,
// so cross-site form POSTs (even from same-site subdomains via fetch
// without CORS allowance) cannot reach this endpoint.
function requireCsrf() {
  return async (c: Context, next: Next) => {
    if (c.req.header("x-twoitter-csrf") !== "1") {
      return c.json({ error: "csrf" }, 403);
    }
    await next();
  };
}

// ---------- auth ----------

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const pw = (form.password as string) || "";
  if (!c.env.PASSWORD || !timingSafeEqual(pw, c.env.PASSWORD)) {
    return c.redirect("/login.html?e=1");
  }
  await setAuthCookie(c, c.env.AUTH_SECRET);
  return c.redirect("/");
});

app.post("/logout", (c) => {
  clearAuthCookie(c);
  return c.redirect("/");
});

app.get("/api/me", async (c) => {
  return c.json({ authed: await isAuthed(c) });
});

// ---------- API: reads (public) ----------

app.get("/api/posts", async (c) => {
  const cursor = c.req.query("cursor") || undefined;
  const tag = c.req.query("tag") || undefined;
  const q = c.req.query("q") || undefined;
  const limitRaw = parseInt(c.req.query("limit") || "20");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
  const result = await listPosts(c.env.DB, { cursor, tag, q, limit });
  return c.json(result);
});

app.get("/api/posts/:id", async (c) => {
  const id = parseInt(c.req.param("id") ?? "");
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);
  const post = await getPost(c.env.DB, id);
  if (!post) return c.json({ error: "no encontrado" }, 404);
  const replies = await getReplies(c.env.DB, id);
  return c.json({ post, replies });
});

app.get("/api/hashtags", async (c) => {
  const tags = await listHashtags(c.env.DB);
  return c.json(tags);
});

// ---------- API: writes (gated) ----------

app.post("/api/posts", requireAuth(), requireCsrf(), async (c) => {
  let body: {
    text?: string | null;
    parent_id?: number | null;
    media?: Array<{
      kind: "image" | "video" | "audio";
      r2_key: string;
      thumb_key?: string | null;
      width?: number | null;
      height?: number | null;
    }>;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }

  const text = (body.text ?? "").trim() || null;
  const media = body.media ?? [];
  if (!text && media.length === 0) {
    return c.json({ error: "post vacio" }, 400);
  }
  if (text && text.length > 4000) {
    return c.json({ error: "texto demasiado largo" }, 400);
  }

  if (body.parent_id != null) {
    const parent = await c.env.DB
      .prepare("SELECT id FROM posts WHERE id = ?")
      .bind(body.parent_id)
      .first<{ id: number }>();
    if (!parent) return c.json({ error: "parent no existe" }, 404);
  }

  const post = await createPost(c.env.DB, text, body.parent_id ?? null);
  await attachMedia(
    c.env.DB,
    post.id,
    media.map((m) => ({
      kind: m.kind,
      r2_key: m.r2_key,
      thumb_key: m.thumb_key ?? null,
      width: m.width ?? null,
      height: m.height ?? null,
    })),
  );
  await syncHashtags(c.env.DB, post.id, text);

  const full = await getPost(c.env.DB, post.id);
  return c.json(full, 201);
});

app.delete("/api/posts/:id", requireAuth(), requireCsrf(), async (c) => {
  const id = parseInt(c.req.param("id") ?? "");
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);
  // Soft delete: el post y sus descendientes se marcan con deleted_at pero
  // los assets de R2 se conservan. Recuperable vía POST /api/posts/:id/restore.
  const result = await deletePost(c.env.DB, c.env.STORAGE, id);
  if (!result) return c.json({ error: "no encontrado" }, 404);
  return c.json({ ok: true, soft_deleted_ids: result.softDeletedIds });
});

app.post("/api/posts/:id/restore", requireAuth(), requireCsrf(), async (c) => {
  const id = parseInt(c.req.param("id") ?? "");
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);
  const result = await restorePost(c.env.DB, id);
  if (!result) return c.json({ error: "no encontrado o no estaba borrado" }, 404);
  return c.json({ ok: true, restored_ids: result.restoredIds });
});

// Transcribe la nota de audio de un post vía Workers AI (Whisper).
// Detrás de auth+CSRF: solo el dueño puede gastar la cuota. Idempotente:
// si el media ya tiene transcript, lo devuelve sin volver a llamar al modelo
// (cachea para siempre — el blob de R2 es inmutable).
app.post("/api/posts/:id/transcribe", requireAuth(), requireCsrf(), async (c) => {
  const id = parseInt(c.req.param("id") ?? "");
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);

  const media = await getAudioMediaForPost(c.env.DB, id);
  if (!media) return c.json({ error: "este post no tiene audio" }, 404);

  // Cache: si ya transcribimos, devolver sin tocar el modelo.
  if (media.transcript) {
    return c.json({ ok: true, transcript: media.transcript, cached: true });
  }

  const obj = await c.env.STORAGE.get(media.r2_key);
  if (!obj) return c.json({ error: "blob no encontrado en r2" }, 404);

  const audioBytes = await obj.arrayBuffer();

  // Workers AI whisper-large-v3-turbo espera `audio` como STRING base64.
  // No number[], no Uint8Array, no binary body — confirmado en docs y por
  // la cascada de errores anteriores ("'string' not in 'array','binary'",
  // "'string' not in 'object'") según en qué rama del oneOf cayera el
  // validador. Base64 string es la única forma fiable hoy.
  const u8 = new Uint8Array(audioBytes);
  let binary = "";
  // chunking necesario: String.fromCharCode.apply con un Uint8Array enorme
  // revienta el stack en algunas runtimes. 32 KB por chunk es seguro y
  // mucho más rápido que ir byte a byte en un loop.
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CHUNK)));
  }
  const base64 = btoa(binary);

  console.log("whisper input:", {
    model: WHISPER_MODEL,
    bytes: audioBytes.byteLength,
    base64_chars: base64.length,
    content_type: obj.httpMetadata?.contentType,
    language: WHISPER_LANGUAGE ?? "auto",
  });

  let transcript: string;
  try {
    const inputs: { audio: string; language?: string } = { audio: base64 };
    if (WHISPER_LANGUAGE) inputs.language = WHISPER_LANGUAGE;
    const result = (await c.env.AI.run(
      WHISPER_MODEL as never,
      inputs as never,
    )) as { text?: string; transcription?: string } | null;
    console.log("whisper raw:", JSON.stringify(result).slice(0, 500));
    transcript = ((result?.text ?? result?.transcription) || "").trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("whisper failed:", msg, err);
    return c.json({ error: `fallo al transcribir: ${msg}` }, 500);
  }

  if (!transcript) {
    return c.json({ error: "transcripción vacía" }, 422);
  }

  await setMediaTranscript(c.env.DB, media.id, transcript);
  return c.json({ ok: true, transcript, cached: false });
});

app.post("/api/upload", requireAuth(), requireCsrf(), async (c) => {
  const ct = c.req.header("x-content-type") || c.req.header("content-type") || "";
  const folderHint = c.req.header("x-folder") as
    | "images"
    | "videos"
    | "audios"
    | "thumbs"
    | undefined;
  const classified = classifyContentType(ct);
  if (!classified) return c.json({ error: "tipo no permitido" }, 400);

  // Rechazo temprano si el Content-Length declarado ya supera el cap: evita
  // bufferizar el body entero antes de descubrir que es demasiado grande.
  // Cliente puede mentir, pero la doble validación tras .arrayBuffer() lo
  // pilla igual.
  const cap = maxBytesFor(classified.kind);
  const declared = parseInt(c.req.header("content-length") || "0");
  if (Number.isFinite(declared) && declared > cap) {
    return c.json({ error: "archivo demasiado grande" }, 413);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > cap) {
    return c.json({ error: "archivo demasiado grande" }, 413);
  }

  const folder: "images" | "videos" | "audios" | "thumbs" =
    folderHint && ["images", "videos", "audios", "thumbs"].includes(folderHint)
      ? folderHint
      : classified.kind === "image"
        ? "images"
        : classified.kind === "audio"
          ? "audios"
          : "videos";

  const key = buildMediaKey(folder, classified.ext);
  await c.env.STORAGE.put(key, body, {
    httpMetadata: { contentType: ct },
  });

  return c.json({ key, url: `/r2/${key}`, kind: classified.kind });
});

app.get("/api/export", requireAuth(), async (c) => {
  const dump = await exportAll(c.env.DB);
  return new Response(JSON.stringify(dump, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="twoitter-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

// ---------- R2 serving (public, like images on twitter) ----------

app.get("/r2/*", async (c) => {
  const key = c.req.path.replace(/^\/r2\//, "");
  const obj = await c.env.STORAGE.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { headers });
});

// ---------- HTML routes ----------

app.get("/", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))),
);
app.get("/post/:id", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/post.html", c.req.url))),
);

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
