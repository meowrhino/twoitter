import { Hono } from "hono";
import {
  isAuthed,
  requireAuth,
  setAuthCookie,
  clearAuthCookie,
} from "./auth";
import {
  attachMedia,
  createPost,
  deletePost,
  exportAll,
  getPost,
  getReplies,
  listHashtags,
  listPosts,
} from "./db";
import { syncHashtags } from "./hashtags";
import {
  buildMediaKey,
  classifyContentType,
  maxBytesFor,
} from "./media";

type Bindings = {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  PASSWORD: string;
  AUTH_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// ---------- auth ----------

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const pw = (form.password as string) || "";
  if (!c.env.PASSWORD || pw !== c.env.PASSWORD) {
    return c.redirect("/login.html?e=1");
  }
  await setAuthCookie(c, c.env.AUTH_SECRET);
  return c.redirect("/");
});

app.post("/logout", (c) => {
  clearAuthCookie(c);
  return c.redirect("/login.html");
});

// ---------- public asset pass-through for login page ----------

app.get("/login.html", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/style.css", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/favicon.ico", (c) => c.env.ASSETS.fetch(c.req.raw));

// ---------- everything below requires auth ----------

app.use("/api/*", requireAuth());
app.use("/r2/*", requireAuth());
app.use("/post/*", requireAuth());

// ---------- API ----------

app.get("/api/posts", async (c) => {
  const cursor = c.req.query("cursor") || undefined;
  const tag = c.req.query("tag") || undefined;
  const q = c.req.query("q") || undefined;
  const limit = parseInt(c.req.query("limit") || "20");
  const result = await listPosts(c.env.DB, { cursor, tag, q, limit });
  return c.json(result);
});

app.get("/api/posts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);
  const post = await getPost(c.env.DB, id);
  if (!post) return c.json({ error: "no encontrado" }, 404);
  const replies = await getReplies(c.env.DB, id);
  return c.json({ post, replies });
});

app.post("/api/posts", async (c) => {
  let body: {
    text?: string | null;
    parent_id?: number | null;
    media?: Array<{
      kind: "image" | "video";
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
    const parent = await getPost(c.env.DB, body.parent_id);
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

app.delete("/api/posts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "id invalido" }, 400);
  const result = await deletePost(c.env.DB, c.env.STORAGE, id);
  if (!result) return c.json({ error: "no encontrado" }, 404);
  return c.json({ ok: true, deleted_keys: result.deletedKeys });
});

app.get("/api/hashtags", async (c) => {
  const tags = await listHashtags(c.env.DB);
  return c.json(tags);
});

app.get("/api/export", async (c) => {
  const dump = await exportAll(c.env.DB);
  return new Response(JSON.stringify(dump, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="twoitter-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

// ---------- uploads ----------

app.post("/api/upload", async (c) => {
  const ct = c.req.header("x-content-type") || c.req.header("content-type") || "";
  const folderHint = c.req.header("x-folder") as
    | "images"
    | "videos"
    | "thumbs"
    | undefined;
  const classified = classifyContentType(ct);
  if (!classified) return c.json({ error: "tipo no permitido" }, 400);

  const body = await c.req.arrayBuffer();
  if (body.byteLength > maxBytesFor(classified.kind)) {
    return c.json({ error: "archivo demasiado grande" }, 413);
  }

  const folder: "images" | "videos" | "thumbs" =
    folderHint && ["images", "videos", "thumbs"].includes(folderHint)
      ? folderHint
      : classified.kind === "image"
        ? "images"
        : "videos";

  const key = buildMediaKey(folder, classified.ext);
  await c.env.STORAGE.put(key, body, {
    httpMetadata: { contentType: ct },
  });

  return c.json({ key, url: `/r2/${key}`, kind: classified.kind });
});

// ---------- R2 serving ----------

app.get("/r2/*", async (c) => {
  const key = c.req.path.replace(/^\/r2\//, "");
  const obj = await c.env.STORAGE.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});

// ---------- HTML routes ----------

app.get("/", async (c) => {
  if (!(await isAuthed(c))) return c.redirect("/login.html");
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url)));
});

app.get("/post/:id", async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL("/post.html", c.req.url)));
});

// fallback: serve static (login.html, etc.) — auth-protected ones are guarded above
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
