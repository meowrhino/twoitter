import { Hono } from "hono";
import {
  isAuthed,
  requireAuth,
  setAuthCookie,
  clearAuthCookie,
  timingSafeEqual,
  readVoterId,
  getOrIssueVoterId,
} from "./auth";
import type { Context, Next } from "hono";
import {
  attachMedia,
  castVote,
  createLyrics,
  createPlace,
  createPoll,
  createPost,
  deletePlace,
  deletePost,
  exportAll,
  findNearbyPlace,
  getMediaById,
  getPost,
  getReplies,
  listHashtags,
  listPlaces,
  listPosts,
  restorePost,
  setMediaTranscript,
  updatePlace,
} from "./db";
import { syncHashtags } from "./hashtags";
import {
  buildMediaKey,
  classifyContentType,
  maxBytesFor,
  uint8ToBase64,
} from "./media";

// ---------- config ----------

// Idioma forzado para Whisper. Las notas de voz del usuario son en castellano,
// y fijarlo evita ~5% de errores donde el detector automático confunde
// audios cortos con portugués o italiano. Para reactivar auto-detect, poner
// null y el endpoint omitirá el campo `language` en la llamada al modelo.
const WHISPER_LANGUAGE: string | null = "es";
const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

// Dueño de los sitios guardados. Hoy hay un solo usuario (auth por contraseña
// compartida) → identidad fija. Cuando entre multi-usuario, esto saldrá de la
// sesión del usuario autenticado.
// OJO multi-usuario: hoy SOLO PATCH/DELETE filtran por owner (atómico en el WHERE).
// GET /api/places (listPlaces) y findNearbyPlace devuelven TODOS los sitios — bien
// para un usuario, pero al añadir más habrá que filtrar también esos dos por owner
// (si no, se filtran nombres/coords ajenos y el dedup del geofence cruza usuarios).
const OWNER_ID = "me";

// Parsea un :id de ruta a entero positivo estricto. null si no es válido (rechaza
// "5abc", "", "-1", "1.5" o ids fuera del rango seguro) → el caller responde 400.
// parseInt aceptaba basura final ("5abc" → 5), actuando sobre el post equivocado.
function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Binding de rate limiting nativo (wrangler.toml [[unsafe.bindings]]).
interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

type Bindings = {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;
  PASSWORD: string;
  AUTH_SECRET: string;
  VOTE_LIMITER: RateLimit;
  WRITE_LIMITER: RateLimit;
  TRANSCRIBE_LIMITER: RateLimit;
};

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  console.error("worker error:", err?.message, err?.stack);
  return c.json({ error: "internal" }, 500);
});

// Cross-origin isolation (COOP/COEP) en TODA respuesta. Habilita SharedArrayBuffer
// (que ffmpeg.wasm multi-thread necesita) desde el primer byte, SIN el viejo
// coi-serviceworker.js (que forzaba 1-2 recargas en la primera visita, lento sobre
// todo en móvil donde iOS evicta el SW). El core de ffmpeg se carga vía toBlobURL
// (blob: same-origin) + fetch CORS a jsdelivr, ambos compatibles con require-corp;
// los medios de R2 van por /r2/* (same-origin, exentos de CORP). iOS soporta
// require-corp (no credentialless), por eso elegimos ese.
// Las respuestas de ASSETS.fetch traen headers inmutables → si .set() lanza,
// reconstruimos la Response.
app.use("*", async (c, next) => {
  await next();
  try {
    c.res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    c.res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  } catch {
    const headers = new Headers(c.res.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  }
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

// Rate limit por IP usando el binding nativo de Workers que se elija. Fail-open
// a propósito (no bloqueamos por un fallo del limitador) pero logueado. `pick`
// selecciona el binding del env (VOTE_LIMITER / WRITE_LIMITER / TRANSCRIBE_LIMITER).
function rateLimit(pick: (env: Bindings) => RateLimit) {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    try {
      const ip = c.req.header("cf-connecting-ip") || "local";
      const { success } = await pick(c.env).limit({ key: ip });
      if (!success) {
        return c.json({ error: "demasiadas peticiones, espera un momento" }, 429);
      }
    } catch (e) {
      console.error("rate limiter no disponible:", e);
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
  // Devolvemos también los límites de encuesta para que el cliente NO tenga
  // que mantener su propia copia (el server es la fuente de verdad). El front
  // ya hace este fetch al arrancar (checkAuth), así que va sin coste extra.
  return c.json({
    authed: await isAuthed(c),
    poll: {
      min: POLL_MIN_OPTIONS,
      max: POLL_MAX_OPTIONS,
      optLen: POLL_OPTION_MAX_LEN,
    },
    lyrics: {
      max: LYRICS_MAX_BLOCKS,
      labelLen: LYRICS_LABEL_MAX_LEN,
      textLen: LYRICS_TEXT_MAX_LEN,
      sourceLen: LYRICS_SOURCE_MAX_LEN,
    },
    // Topes de tamaño (bytes) por tipo, para que el cliente avise ANTES de
    // subir en vez de tras el upload. El server los revalida igualmente.
    media: {
      image: maxBytesFor("image"),
      video: maxBytesFor("video"),
      audio: maxBytesFor("audio"),
    },
  });
});

// ---------- API: reads (public) ----------

// Tipos de contenido filtrables por ?type= en /api/posts. image|video|audio
// miran a media.kind; poll|lyrics miran a su propia tabla (ver listPosts).
const POST_TYPES = new Set(["image", "video", "audio", "poll", "lyrics"]);
type PostType = "image" | "video" | "audio" | "poll" | "lyrics";

app.get("/api/posts", async (c) => {
  const cursor = c.req.query("cursor") || undefined;
  const tag = c.req.query("tag") || undefined;
  const q = c.req.query("q") || undefined;
  const rawType = c.req.query("type");
  const type = rawType && POST_TYPES.has(rawType) ? (rawType as PostType) : undefined;
  // Default 100 por página; el frontend carga "todo" progresivamente con
  // auto-fetch. listPosts capa a 100 (Math.min) por el límite de subrequests
  // y de parámetros vinculados de D1.
  const limitRaw = parseInt(c.req.query("limit") || "100");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  // voterId solo si el visitante ya tiene cookie firmada — no emitimos
  // cookies en GETs: la primera cookie nace al votar.
  const voterId = await readVoterId(c);
  const result = await listPosts(c.env.DB, { cursor, tag, q, type, limit, voterId });
  return c.json(result);
});

app.get("/api/posts/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const voterId = await readVoterId(c);
  const post = await getPost(c.env.DB, id, voterId);
  if (!post) return c.json({ error: "no encontrado" }, 404);
  const replies = await getReplies(c.env.DB, id, voterId);
  return c.json({ post, replies });
});

app.get("/api/hashtags", async (c) => {
  const tags = await listHashtags(c.env.DB);
  return c.json(tags);
});

// Sitios guardados (geofence). Datos del dueño → requireAuth. El composer los
// pide al cargar para autorrellenar el nombre cuando capturas GPS cerca de uno.
app.get("/api/places", requireAuth(), async (c) => {
  return c.json(await listPlaces(c.env.DB));
});

// Renombrar / ajustar radio de un sitio. Solo el dueño (updatePlace filtra por
// owner). 404 si no existe o no es tuyo.
app.patch("/api/places/:id", requireAuth(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  let body: { name?: string; radius?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  // String(): un body manipulado podría mandar name no-string (número/objeto);
  // sin coerción, .trim() lanzaría → 500 en vez de un 400 limpio.
  const name = String(body.name ?? "").trim().slice(0, LOCATION_MAX_LEN);
  if (!name) return c.json({ error: "nombre vacio" }, 400);
  // Radio en metros: clamp a [10, 100000]; valor inválido → 150 por defecto.
  const raw = Number(body.radius);
  const radius = Number.isFinite(raw) && raw >= 10 && raw <= 100000 ? raw : 150;
  const updated = await updatePlace(c.env.DB, id, { name, radius }, OWNER_ID);
  if (!updated) return c.json({ error: "no encontrado" }, 404);
  return c.json(updated);
});

// Borrar un sitio guardado. Solo el dueño. 404 si no existe o no es tuyo.
app.delete("/api/places/:id", requireAuth(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const ok = await deletePlace(c.env.DB, id, OWNER_ID);
  if (!ok) return c.json({ error: "no encontrado" }, 404);
  return c.json({ ok: true });
});

// ---------- API: writes (gated) ----------

// Límites de encuesta. Tope blando, fácil de subir si hace falta.
const POLL_MAX_OPTIONS = 10;
const POLL_MIN_OPTIONS = 2;
const POLL_OPTION_MAX_LEN = 80;

// Límites de bloques de letras (lyrics). Un post-letra suele traer 1-3
// versiones (original/romaji/traducción); 6 da margen sin permitir spam.
// textLen generoso (una canción larga con florituras cabe de sobra).
const LYRICS_MAX_BLOCKS = 6;
const LYRICS_LABEL_MAX_LEN = 40;
const LYRICS_TEXT_MAX_LEN = 20000;
const LYRICS_SOURCE_MAX_LEN = 300;

type PostBody = {
  text?: string | null;
  parent_id?: number | null;
  media?: Array<{
    kind: "image" | "video" | "audio";
    r2_key: string;
    thumb_key?: string | null;
    width?: number | null;
    height?: number | null;
  }>;
  poll?: { options?: unknown } | null;
  // Letras (lyrics) opcionales: bloques {label, text} + fuente libre.
  lyrics?: { source?: string | null; blocks?: unknown } | null;
  // Ubicación opcional: etiqueta de texto + coords (del botón "ubicación").
  location?: string | null;
  lat?: number | null;
  lng?: number | null;
};

type MediaInput = {
  kind: "image" | "video" | "audio";
  r2_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
};

type LyricsBlockInput = { label: string; text: string };

type PostValidation =
  | { ok: false; error: string; status: 400 | 404 }
  | {
      ok: true;
      text: string | null;
      media: MediaInput[];
      pollOptions: string[] | null;
      lyricsBlocks: LyricsBlockInput[] | null;
      lyricsSource: string | null;
      parentId: number | null;
      location: string | null;
      lat: number | null;
      lng: number | null;
    };

// Valida y sanea el body de un post nuevo. Devuelve los valores listos para
// persistir, o el primer error con su status. Async porque comprueba en BD que
// el parent exista. Exportada para testear la validación aislada del HTTP.
export async function validatePostBody(
  db: D1Database,
  body: PostBody,
): Promise<PostValidation> {
  const text = (body.text ?? "").trim() || null;
  const rawMedia = body.media ?? [];

  // Encuesta (si viene). Se permite encuesta sin texto: la decisión de diseño
  // fue "texto del post = pregunta", pero una pregunta solo-media (p. ej. dos
  // imágenes "¿cuál?") es válida, así que no forzamos texto aquí.
  let pollOptions: string[] | null = null;
  if (body.poll && Array.isArray(body.poll.options)) {
    const opts = body.poll.options
      .map((o) => (typeof o === "string" ? o.trim() : ""))
      .filter((o) => o.length > 0);
    if (opts.length < POLL_MIN_OPTIONS)
      return { ok: false, error: "la encuesta necesita al menos 2 opciones", status: 400 };
    if (opts.length > POLL_MAX_OPTIONS)
      return { ok: false, error: `máximo ${POLL_MAX_OPTIONS} opciones`, status: 400 };
    if (opts.some((o) => o.length > POLL_OPTION_MAX_LEN))
      return { ok: false, error: `opciones de máx ${POLL_OPTION_MAX_LEN} caracteres`, status: 400 };
    pollOptions = opts;
  }

  // Letras (si vienen). Cada bloque es una versión/idioma; se descartan los
  // que llegan sin texto. La fuente es libre (URL o cita) y opcional.
  let lyricsBlocks: LyricsBlockInput[] | null = null;
  let lyricsSource: string | null = null;
  if (body.lyrics && Array.isArray(body.lyrics.blocks)) {
    let untitledCount = 0;
    const blocks = body.lyrics.blocks
      .map((b) => {
        const o = b as { label?: unknown; text?: unknown };
        return {
          label: typeof o?.label === "string" ? o.label.trim() : "",
          text: typeof o?.text === "string" ? o.text.trim() : "",
        };
      })
      .filter((b) => b.text.length > 0)
      .map((b) => {
        if (b.label) return b;
        untitledCount++;
        return { ...b, label: untitledCount === 1 ? "sin título" : `sin título ${untitledCount}` };
      });
    if (blocks.length === 0)
      return { ok: false, error: "las letras necesitan al menos 1 bloque con texto", status: 400 };
    if (blocks.length > LYRICS_MAX_BLOCKS)
      return { ok: false, error: `máximo ${LYRICS_MAX_BLOCKS} bloques de letras`, status: 400 };
    if (blocks.some((b) => b.label.length > LYRICS_LABEL_MAX_LEN))
      return { ok: false, error: `idioma/etiqueta de máx ${LYRICS_LABEL_MAX_LEN} caracteres`, status: 400 };
    if (blocks.some((b) => b.text.length > LYRICS_TEXT_MAX_LEN))
      return { ok: false, error: `bloque de letras de máx ${LYRICS_TEXT_MAX_LEN} caracteres`, status: 400 };
    lyricsBlocks = blocks;
    lyricsSource = String(body.lyrics.source ?? "").trim().slice(0, LYRICS_SOURCE_MAX_LEN) || null;
  }

  if (!text && rawMedia.length === 0 && !pollOptions && !lyricsBlocks)
    return { ok: false, error: "post vacio", status: 400 };
  if (text && text.length > 4000)
    return { ok: false, error: "texto demasiado largo", status: 400 };
  // Cap de media: sin tope, un body manipulado podría spamear la tabla media.
  if (rawMedia.length > 12)
    return { ok: false, error: "demasiados adjuntos", status: 400 };
  // Validación runtime de cada media: los tipos TS no aplican en runtime y el
  // schema no tiene CHECK, así que un body manipulado podría meter basura.
  for (const m of rawMedia) {
    if (m.kind !== "image" && m.kind !== "video" && m.kind !== "audio")
      return { ok: false, error: "kind de media invalido", status: 400 };
    if (typeof m.r2_key !== "string" || !m.r2_key)
      return { ok: false, error: "media sin r2_key", status: 400 };
  }

  if (body.parent_id != null) {
    // deleted_at IS NULL: no se puede responder a un post borrado (su id sigue
    // en la BD pero no debe aceptar replies nuevas).
    const parent = await db
      .prepare("SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL")
      .bind(body.parent_id)
      .first<{ id: number }>();
    if (!parent) return { ok: false, error: "parent no existe", status: 404 };
  }

  const media: MediaInput[] = rawMedia.map((m) => ({
    kind: m.kind,
    r2_key: m.r2_key,
    thumb_key: m.thumb_key ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
  }));

  // Ubicación. La etiqueta se trunca a LOCATION_MAX_LEN (defensa: el input ya
  // limita en cliente). Las coords solo se guardan si AMBAS son números válidos
  // en rango — un map link necesita lat y lng; media coord no sirve.
  const location = String(body.location ?? "").trim().slice(0, LOCATION_MAX_LEN) || null;
  const { lat, lng } = parseCoords(body.lat, body.lng);

  return {
    ok: true,
    text,
    media,
    pollOptions,
    lyricsBlocks,
    lyricsSource,
    parentId: body.parent_id ?? null,
    location,
    lat,
    lng,
  };
}

// Tope de la etiqueta de ubicación (coincide con el maxlength del input).
const LOCATION_MAX_LEN = 120;

// Valida un par lat/lng. Devuelve ambos como número solo si los dos son finitos
// y caen en rango geográfico; en cualquier otro caso devuelve ambos null (no
// guardamos una coord suelta: el link a mapa necesita las dos).
function parseCoords(rawLat: unknown, rawLng: unknown): { lat: number | null; lng: number | null } {
  // null/undefined/"" = "no vino coord". OJO: Number(null) === 0 (un punto
  // válido en el golfo de Guinea), así que sin este guard un post con SOLO
  // etiqueta de texto acabaría con lat/lng 0,0 y un link a mapa espurio.
  if (rawLat == null || rawLng == null || rawLat === "" || rawLng === "")
    return { lat: null, lng: null };
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  const ok =
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  return ok ? { lat, lng } : { lat: null, lng: null };
}

// Persiste un post ya validado (fila + media + hashtags + encuesta).
// Devuelve el id del post creado. Exportada para testear la persistencia.
export async function persistPost(
  db: D1Database,
  v: {
    text: string | null;
    media: MediaInput[];
    pollOptions: string[] | null;
    lyricsBlocks?: LyricsBlockInput[] | null;
    lyricsSource?: string | null;
    parentId: number | null;
    location: string | null;
    lat: number | null;
    lng: number | null;
  },
): Promise<number> {
  const post = await createPost(db, v.text, v.parentId, v.location, v.lat, v.lng);
  await Promise.all([
    attachMedia(db, post.id, v.media),
    syncHashtags(db, post.id, v.text),
  ]);
  if (v.pollOptions) await createPoll(db, post.id, v.pollOptions);
  if (v.lyricsBlocks) {
    await createLyrics(db, post.id, v.lyricsSource ?? null, v.lyricsBlocks);
  }

  // Geofence: si el post trae ubicación CON NOMBRE + coords y no hay ya un sitio
  // guardado dentro de su radio, lo guardamos para autorrellenar la próxima vez.
  // En try/catch: un fallo aquí nunca debe tumbar la publicación (el post ya está).
  if (v.location && v.lat != null && v.lng != null) {
    try {
      const near = await findNearbyPlace(db, v.lat, v.lng);
      if (!near) await createPlace(db, v.location, v.lat, v.lng, 150, OWNER_ID);
    } catch (err) {
      console.error("auto-save place failed:", err);
    }
  }
  return post.id;
}

app.post("/api/posts", requireAuth(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
  let body: PostBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }

  const v = await validatePostBody(c.env.DB, body);
  if (!v.ok) return c.json({ error: v.error }, v.status);
  const postId = await persistPost(c.env.DB, v);

  // No emitimos cookie tv_id en este endpoint (no mezclar auth con identidad de
  // voto); si el autor ya tenía una, la respetamos para calcular my_vote_id.
  const voterId = await readVoterId(c);
  const full = await getPost(c.env.DB, postId, voterId);
  return c.json(full, 201);
});

app.delete("/api/posts/:id", requireAuth(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  // Soft delete: el post y sus descendientes se marcan con deleted_at pero
  // los assets de R2 se conservan. Recuperable vía POST /api/posts/:id/restore.
  const result = await deletePost(c.env.DB, id);
  if (!result) return c.json({ error: "no encontrado" }, 404);
  return c.json({ ok: true, soft_deleted_ids: result.softDeletedIds });
});

app.post("/api/posts/:id/restore", requireAuth(), requireCsrf(), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);
  const result = await restorePost(c.env.DB, id);
  if (!result) return c.json({ error: "no encontrado o no estaba borrado" }, 404);
  return c.json({ ok: true, restored_ids: result.restoredIds });
});

// Transcribe UNA nota de audio concreta (por media id) vía Workers AI (Whisper).
// Antes era por post y sólo cogía el primer audio; ahora cada audio de un twoitt
// se transcribe y cachea por separado, así un post con varias notas las tiene
// todas. Detrás de auth+CSRF: solo el dueño gasta cuota. Idempotente: si el media
// ya tiene transcript, lo devuelve sin volver a llamar al modelo (cachea para
// siempre — el blob de R2 es inmutable).
app.post("/api/media/:id/transcribe", requireAuth(), requireCsrf(), rateLimit((e) => e.TRANSCRIBE_LIMITER), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);

  const media = await getMediaById(c.env.DB, id);
  if (!media || media.kind !== "audio") {
    return c.json({ error: "media de audio no encontrado" }, 404);
  }

  // Cache: si ya transcribimos, devolver sin tocar el modelo.
  if (media.transcript) {
    return c.json({
      ok: true,
      transcript: media.transcript,
      transcribed_at: media.transcribed_at,
      cached: true,
    });
  }

  const obj = await c.env.STORAGE.get(media.r2_key);
  if (!obj) return c.json({ error: "blob no encontrado en r2" }, 404);

  const audioBytes = await obj.arrayBuffer();

  // Workers AI whisper-large-v3-turbo espera `audio` como STRING base64.
  // No number[], no Uint8Array, no binary body — confirmado en docs y por
  // la cascada de errores anteriores ("'string' not in 'array','binary'",
  // "'string' not in 'object'") según en qué rama del oneOf cayera el
  // validador. Base64 string es la única forma fiable hoy.
  const base64 = uint8ToBase64(new Uint8Array(audioBytes));

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

  const transcribed_at = await setMediaTranscript(c.env.DB, media.id, transcript);
  return c.json({ ok: true, transcript, transcribed_at, cached: false });
});

// Votar en una encuesta. Público (no requireAuth) — los visitantes anónimos
// son el caso de uso principal. Sí pasa por requireCsrf: el header
// x-twoitter-csrf evita que un sitio externo dispare votos vía form POST.
// Voto inmutable: si ya votaste devuelve 409 con tu voto previo, no permite
// cambiarlo.
// Rate limit (VOTE_LIMITER) vía middleware: este endpoint es PÚBLICO, un script
// podría spamear votos rotando cookies tv_id. 30/min por IP frena el abuso.
app.post("/api/posts/:id/poll/vote", requireCsrf(), rateLimit((e) => e.VOTE_LIMITER), async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "id invalido" }, 400);

  let body: { option_id?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "json invalido" }, 400);
  }
  const optionId = Number(body.option_id);
  if (!Number.isFinite(optionId) || optionId <= 0) {
    return c.json({ error: "option_id invalido" }, 400);
  }

  // Comprobamos que el post existe y no está borrado antes de tocar
  // cookies — así no emitimos tv_id por votos a posts inexistentes.
  const exists = await c.env.DB
    .prepare("SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ id: number }>();
  if (!exists) return c.json({ error: "post no encontrado" }, 404);

  const voterId = await getOrIssueVoterId(c);
  const result = await castVote(c.env.DB, id, voterId, optionId);
  if (!result.ok) {
    if (result.error === "no_poll") {
      return c.json({ error: "este post no tiene encuesta" }, 404);
    }
    if (result.error === "bad_option") {
      return c.json({ error: "opción no pertenece a esta encuesta" }, 400);
    }
    if (result.error === "already_voted") {
      // Devolvemos el estado actualizado para que el cliente pueda pintar
      // la encuesta con el voto previo aunque haya perdido contexto.
      const full = await getPost(c.env.DB, id, voterId);
      return c.json({ error: "ya votaste", poll: full?.poll ?? null }, 409);
    }
    return c.json({ error: "no se pudo votar" }, 500);
  }
  const full = await getPost(c.env.DB, id, voterId);
  return c.json({ ok: true, poll: full?.poll ?? null });
});

app.post("/api/upload", requireAuth(), requireCsrf(), rateLimit((e) => e.WRITE_LIMITER), async (c) => {
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

// Soporta HTTP Range requests. Sin esto el navegador no puede MOVER la barra de
// un vídeo: el seek manda `Range: bytes=…` y necesita un `206 Partial Content`
// con `Content-Range`. Se notaba sobre todo con MP4 (índice `moov` al final →
// obliga a leer por rangos); un WebM recién encodeado a veces buscaba dentro de
// lo ya bufferizado y disimulaba el fallo. Pasándole las cabeceras de la request
// a R2, este parsea el `Range` y devuelve el objeto con `.range` resuelto.
app.get("/r2/*", async (c) => {
  const key = c.req.path.replace(/^\/r2\//, "");
  const rangeHeader = c.req.header("range");
  const obj = await c.env.STORAGE.get(
    key,
    rangeHeader ? { range: c.req.raw.headers } : undefined,
  );
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  headers.set("accept-ranges", "bytes");

  // R2 sólo trae `.range` si aplicó un rango. Cubrimos las tres formas de
  // R2Range ({offset,length} | {length} | {suffix}) para calcular Content-Range.
  if (rangeHeader && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix != null ? obj.size - r.suffix : r.offset ?? 0;
    const length = r.suffix != null ? r.suffix : r.length ?? obj.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
});

// ---------- HTML routes ----------

app.get("/", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url))),
);
// Página ligera para publicar (sin el peso del timeline), pensada para poco
// internet. Sirve compose.html para la URL bonita /compose.
app.get("/compose", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/compose.html", c.req.url))),
);
// Gestión de sitios guardados (renombrar / borrar / ajustar radio).
app.get("/places", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/places.html", c.req.url))),
);
// /post/:id quedó obsoleto: ya no hay vista detalle. El feed es ahora un
// "carrete plano" donde cada post es una posición. Redirigimos 301 a /#id
// para no romper enlaces antiguos compartidos fuera (RSS, capturas, etc.).
app.get("/post/:id", (c) => {
  const id = c.req.param("id");
  return c.redirect(`/#${id}`, 301);
});

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
