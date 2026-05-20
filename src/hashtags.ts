const TAG_RE = /#([\p{L}\p{N}_]+)/gu;

export function extractHashtags(text: string | null | undefined): string[] {
  if (!text) return [];
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG_RE)) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

export async function syncHashtags(
  db: D1Database,
  postId: number,
  text: string | null,
) {
  const tags = extractHashtags(text);
  await db.prepare("DELETE FROM hashtags WHERE post_id = ?").bind(postId).run();
  if (tags.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO hashtags (post_id, tag) VALUES (?, ?)",
  );
  await db.batch(tags.map((t) => stmt.bind(postId, t)));
}
