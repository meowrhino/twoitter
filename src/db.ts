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
}

export interface Post extends PostRow {
  media: MediaRow[];
  hashtags: string[];
  reply_count: number;
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

export async function listPosts(
  db: D1Database,
  opts: { cursor?: string; tag?: string; q?: string; limit: number },
): Promise<{ posts: Post[]; nextCursor: string | null }> {
  const limit = Math.min(50, Math.max(1, opts.limit));
  const conds: string[] = ["p.parent_id IS NULL"];
  const args: unknown[] = [];

  if (opts.tag) {
    conds.push(
      "EXISTS (SELECT 1 FROM hashtags h WHERE h.post_id = p.id AND h.tag = ?)",
    );
    args.push(opts.tag.toLowerCase());
  }
  if (opts.q) {
    conds.push("p.text LIKE ?");
    args.push(`%${opts.q}%`);
  }
  if (opts.cursor) {
    conds.push("p.created_at < ?");
    args.push(opts.cursor);
  }

  const sql = `SELECT p.* FROM posts p WHERE ${conds.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`;
  args.push(limit + 1);

  const res = await db
    .prepare(sql)
    .bind(...args)
    .all<PostRow>();
  const rows = res.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const posts = await attachMediaAndTags(db, page);
  const nextCursor = hasMore ? page[page.length - 1].created_at : null;
  return { posts, nextCursor };
}

export async function getPost(
  db: D1Database,
  id: number,
): Promise<Post | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE id = ?")
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
      "SELECT * FROM posts WHERE parent_id = ? ORDER BY created_at ASC",
    )
    .bind(parentId)
    .all<PostRow>();
  return attachMediaAndTags(db, res.results);
}

export async function createPost(
  db: D1Database,
  text: string | null,
  parentId: number | null,
): Promise<PostRow> {
  const row = await db
    .prepare(
      "INSERT INTO posts (text, parent_id) VALUES (?, ?) RETURNING *",
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
  storage: R2Bucket,
  id: number,
): Promise<{ deletedKeys: string[] } | null> {
  const post = await getPost(db, id);
  if (!post) return null;

  // collect r2 keys from this post and all its descendants (1-level: replies of replies are rare here)
  const replies = await getReplies(db, id);
  const allMedia = [...post.media, ...replies.flatMap((r) => r.media)];
  const keys = allMedia.flatMap((m) =>
    m.thumb_key ? [m.r2_key, m.thumb_key] : [m.r2_key],
  );

  await db.batch([
    db.prepare("DELETE FROM hashtags WHERE post_id = ?").bind(id),
    db.prepare("DELETE FROM media WHERE post_id = ?").bind(id),
    db
      .prepare(
        "DELETE FROM hashtags WHERE post_id IN (SELECT id FROM posts WHERE parent_id = ?)",
      )
      .bind(id),
    db
      .prepare(
        "DELETE FROM media WHERE post_id IN (SELECT id FROM posts WHERE parent_id = ?)",
      )
      .bind(id),
    db.prepare("DELETE FROM posts WHERE parent_id = ?").bind(id),
    db.prepare("DELETE FROM posts WHERE id = ?").bind(id),
  ]);

  await Promise.all(keys.map((k) => storage.delete(k)));

  return { deletedKeys: keys };
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
