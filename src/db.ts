export interface MediaRow {
  id: number;
  post_id: number;
  kind: "image" | "video";
  r2_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  position: number;
}

export interface PostRow {
  id: number;
  text: string | null;
  parent_id: number | null;
  created_at: string;
  deleted_at?: string | null;
}

export interface Post extends PostRow {
  media: MediaRow[];
  hashtags: string[];
  reply_count: number;
  replies?: Post[];
}

async function attachMediaAndTags(
  db: D1Database,
  posts: PostRow[],
): Promise<Post[]> {
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(",");

  const [mediaRes, tagRes, repliesRes] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM media WHERE post_id IN (${placeholders}) ORDER BY post_id, position`,
      )
      .bind(...ids)
      .all<MediaRow>(),
    db
      .prepare(
        `SELECT post_id, tag FROM hashtags WHERE post_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<{ post_id: number; tag: string }>(),
    db
      .prepare(
        `SELECT parent_id, COUNT(*) as c FROM posts WHERE parent_id IN (${placeholders}) GROUP BY parent_id`,
      )
      .bind(...ids)
      .all<{ parent_id: number; c: number }>(),
  ]);

  const mediaByPost = new Map<number, MediaRow[]>();
  for (const m of mediaRes.results) {
    const arr = mediaByPost.get(m.post_id) || [];
    arr.push(m);
    mediaByPost.set(m.post_id, arr);
  }
  const tagsByPost = new Map<number, string[]>();
  for (const t of tagRes.results) {
    const arr = tagsByPost.get(t.post_id) || [];
    arr.push(t.tag);
    tagsByPost.set(t.post_id, arr);
  }
  const repliesByPost = new Map<number, number>();
  for (const r of repliesRes.results) {
    repliesByPost.set(r.parent_id, r.c);
  }

  return posts.map((p) => ({
    ...p,
    media: mediaByPost.get(p.id) || [],
    hashtags: tagsByPost.get(p.id) || [],
    reply_count: repliesByPost.get(p.id) || 0,
  }));
}

function buildReplyTree(all: Post[]): void {
  const byParent = new Map<number, Post[]>();
  for (const p of all) {
    if (p.parent_id == null) continue;
    const arr = byParent.get(p.parent_id) || [];
    arr.push(p);
    byParent.set(p.parent_id, arr);
  }
  for (const p of all) {
    p.replies = byParent.get(p.id) || [];
  }
}

export async function listPosts(
  db: D1Database,
  opts: { cursor?: string; tag?: string; q?: string; limit: number },
): Promise<{ posts: Post[]; nextCursor: string | null }> {
  const limit = Math.min(50, Math.max(1, opts.limit));
  // deleted_at IS NULL en TODAS las queries de lectura: los borrados
  // siguen en la BD para poder restaurar pero no aparecen en el feed.
  const conds: string[] = ["p.parent_id IS NULL", "p.deleted_at IS NULL"];
  const args: unknown[] = [];

  if (opts.tag) {
    conds.push(
      "EXISTS (SELECT 1 FROM hashtags h WHERE h.post_id = p.id AND h.tag = ?)",
    );
    args.push(opts.tag.toLowerCase());
  }
  if (opts.q && opts.q.length <= 200) {
    // escape LIKE wildcards so user-typed % and _ are literal
    const escaped = opts.q.replace(/[\\%_]/g, "\\$&");
    conds.push("p.text LIKE ? ESCAPE '\\'");
    args.push(`%${escaped}%`);
  }
  if (opts.cursor) {
    // cursor encodes (created_at|id) to break ties on same-second posts
    const [cAt, cIdStr] = opts.cursor.split("|");
    const cId = parseInt(cIdStr || "0");
    if (cAt && Number.isFinite(cId)) {
      conds.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
      args.push(cAt, cAt, cId);
    }
  }

  const sql = `SELECT p.* FROM posts p WHERE ${conds.join(" AND ")} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`;
  args.push(limit + 1);

  const res = await db
    .prepare(sql)
    .bind(...args)
    .all<PostRow>();
  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  if (page.length === 0) {
    return { posts: [], nextCursor: null };
  }

  // fetch every descendant of the roots in this page (any depth) with a recursive CTE.
  // El level cap (256) es defensa contra ciclos accidentales en parent_id o threads
  // patológicamente profundos — sin él, un bucle haría que SQLite recorra hasta
  // agotar memoria. 256 niveles es muchísimo para conversaciones reales.
  const rootIds = page.map((p) => p.id);
  const placeholders = rootIds.map(() => "?").join(",");
  const descRes = await db
    .prepare(
      `WITH RECURSIVE descendants(id, text, parent_id, created_at, level) AS (
         SELECT p.id, p.text, p.parent_id, p.created_at, 1
           FROM posts p WHERE p.parent_id IN (${placeholders}) AND p.deleted_at IS NULL
         UNION ALL
         SELECT c.id, c.text, c.parent_id, c.created_at, d.level + 1
           FROM posts c JOIN descendants d ON c.parent_id = d.id
           WHERE d.level < 256 AND c.deleted_at IS NULL
       )
       SELECT id, text, parent_id, created_at FROM descendants ORDER BY created_at ASC`,
    )
    .bind(...rootIds)
    .all<PostRow>();

  const allWithExtras = await attachMediaAndTags(db, [
    ...page,
    ...descRes.results,
  ]);
  buildReplyTree(allWithExtras);

  // preserve the ordered roots (created_at DESC) from the paginated query
  const byId = new Map(allWithExtras.map((p) => [p.id, p]));
  const roots = page.map((r) => byId.get(r.id)!).filter(Boolean);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null;
  return { posts: roots, nextCursor };
}

export async function getPost(
  db: D1Database,
  id: number,
): Promise<Post | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<PostRow>();
  if (!row) return null;
  const [withExtras] = await attachMediaAndTags(db, [row]);
  return withExtras;
}

export async function getReplies(
  db: D1Database,
  parentId: number,
): Promise<Post[]> {
  const res = await db
    .prepare(
      `WITH RECURSIVE descendants(id, text, parent_id, created_at, level) AS (
         SELECT p.id, p.text, p.parent_id, p.created_at, 1
           FROM posts p WHERE p.parent_id = ? AND p.deleted_at IS NULL
         UNION ALL
         SELECT c.id, c.text, c.parent_id, c.created_at, d.level + 1
           FROM posts c JOIN descendants d ON c.parent_id = d.id
           WHERE d.level < 256 AND c.deleted_at IS NULL
       )
       SELECT id, text, parent_id, created_at FROM descendants ORDER BY created_at ASC`,
    )
    .bind(parentId)
    .all<PostRow>();
  const all = await attachMediaAndTags(db, res.results);
  buildReplyTree(all);
  return all.filter((p) => p.parent_id === parentId);
}

export async function createPost(
  db: D1Database,
  text: string | null,
  parentId: number | null,
): Promise<PostRow> {
  const row = await db
    .prepare(
      "INSERT INTO posts (text, parent_id, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING *",
    )
    .bind(text, parentId)
    .first<PostRow>();
  return row!;
}

export async function attachMedia(
  db: D1Database,
  postId: number,
  items: Array<{
    kind: "image" | "video";
    r2_key: string;
    thumb_key: string | null;
    width: number | null;
    height: number | null;
  }>,
) {
  if (items.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO media (post_id, kind, r2_key, thumb_key, width, height, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(
    items.map((m, i) =>
      stmt.bind(postId, m.kind, m.r2_key, m.thumb_key, m.width, m.height, i),
    ),
  );
}

export async function deletePost(
  db: D1Database,
  _storage: R2Bucket,
  id: number,
): Promise<{ softDeletedIds: number[] } | null> {
  // Soft delete: marca deleted_at en el post y sus descendientes pero deja
  // todo intacto (media, hashtags, assets de R2). Para restaurar, basta
  // con NULL-ear deleted_at. Si en el futuro queremos vaciado de papelera
  // físico, añadir una operación 'purge' separada que sí haga DELETE + R2.
  const exists = await db
    .prepare("SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ id: number }>();
  if (!exists) return null;

  // Reunir todos los descendientes vivos (cualquier profundidad).
  const idsRes = await db
    .prepare(
      `WITH RECURSIVE descendants(id, level) AS (
         SELECT id, 1 FROM posts WHERE id = ?
         UNION ALL
         SELECT p.id, d.level + 1
           FROM posts p JOIN descendants d ON p.parent_id = d.id
           WHERE d.level < 256 AND p.deleted_at IS NULL
       )
       SELECT id FROM descendants`,
    )
    .bind(id)
    .all<{ id: number }>();
  const ids = idsRes.results.map((r) => r.id);
  if (ids.length === 0) return { softDeletedIds: [] };
  const placeholders = ids.map(() => "?").join(",");

  await db
    .prepare(
      `UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .run();

  return { softDeletedIds: ids };
}

// Restaurar un post (y sus descendientes que cayeron en el mismo borrado)
// poniendo deleted_at = NULL. Útil para una futura vista /papelera.
export async function restorePost(
  db: D1Database,
  id: number,
): Promise<{ restoredIds: number[] } | null> {
  const exists = await db
    .prepare("SELECT id, deleted_at FROM posts WHERE id = ?")
    .bind(id)
    .first<{ id: number; deleted_at: string | null }>();
  if (!exists || !exists.deleted_at) return null;
  // Restaura sólo los que se borraron en el MISMO momento (mismo deleted_at)
  // para no resucitar borrados anteriores cuando un subtree se restaura.
  const res = await db
    .prepare(
      `UPDATE posts SET deleted_at = NULL
         WHERE deleted_at = ?
         RETURNING id`,
    )
    .bind(exists.deleted_at)
    .all<{ id: number }>();
  return { restoredIds: res.results.map((r) => r.id) };
}

export async function listHashtags(
  db: D1Database,
): Promise<Array<{ tag: string; count: number }>> {
  const res = await db
    .prepare(
      "SELECT tag, COUNT(*) as count FROM hashtags GROUP BY tag ORDER BY count DESC, tag ASC",
    )
    .all<{ tag: string; count: number }>();
  return res.results;
}

export async function exportAll(db: D1Database) {
  const [posts, media, hashtags] = await Promise.all([
    db.prepare("SELECT * FROM posts ORDER BY id").all(),
    db.prepare("SELECT * FROM media ORDER BY post_id, position").all(),
    db.prepare("SELECT * FROM hashtags ORDER BY post_id, tag").all(),
  ]);
  return {
    exported_at: new Date().toISOString(),
    posts: posts.results,
    media: media.results,
    hashtags: hashtags.results,
  };
}
