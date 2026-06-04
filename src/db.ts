export interface MediaRow {
  id: number;
  post_id: number;
  kind: "image" | "video" | "audio";
  r2_key: string;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  // Sólo se rellena para kind='audio' tras llamar a /transcribe.
  // NULL = aún no transcrito.
  transcript: string | null;
  position: number;
}

export interface PostRow {
  id: number;
  text: string | null;
  parent_id: number | null;
  created_at: string;
  deleted_at?: string | null;
}

export interface PollOptionPublic {
  id: number;
  position: number;
  label: string;
  votes: number;
}

export interface PollPublic {
  options: PollOptionPublic[];
  total_votes: number;
  // option_id que ha votado el visitante actual, o null si no ha votado / no
  // hay cookie tv_id. Se resuelve por petición: en /api/posts cada post lleva
  // su my_vote_id ya calculado para que el frontend pinte sin más fetchs.
  my_vote_id: number | null;
}

export interface ParentExcerpt {
  id: number;
  text_snippet: string;
  deleted: boolean;
}

export interface Post extends PostRow {
  media: MediaRow[];
  hashtags: string[];
  reply_count: number;
  replies?: Post[];
  // Sólo presente si el post tiene una fila en `polls`. Null/undefined si no.
  poll?: PollPublic | null;
  // Sólo presente cuando parent_id != null. Permite al frontend pintar el
  // header "↓ en respuesta a: «snippet»" sin un fetch extra del padre.
  parent_excerpt?: ParentExcerpt | null;
}

// Carga en bloque (1 query por relación, N posts) los extras de cada post:
// media, hashtags, reply_count y poll. voterId opcional → si viene, cada
// PollPublic resultante incluye `my_vote_id` para que el frontend pinte el
// estado "ya votaste" sin un segundo fetch.
async function attachMediaAndTags(
  db: D1Database,
  posts: PostRow[],
  voterId: string | null = null,
): Promise<Post[]> {
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(",");

  // Query del voto del visitante: solo si tenemos voterId, evitamos un
  // query inútil cuando nadie ha emitido cookie todavía.
  const myVotesPromise: Promise<{ results: Array<{ post_id: number; option_id: number }> }> = voterId
    ? db
        .prepare(
          `SELECT post_id, option_id FROM poll_votes WHERE voter_id = ? AND post_id IN (${placeholders})`,
        )
        .bind(voterId, ...ids)
        .all<{ post_id: number; option_id: number }>()
    : Promise.resolve({ results: [] });

  const [mediaRes, tagRes, repliesRes, pollsRes, optionsRes, voteCountsRes, myVotesRes] =
    await Promise.all([
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
      db
        .prepare(
          `SELECT post_id FROM polls WHERE post_id IN (${placeholders})`,
        )
        .bind(...ids)
        .all<{ post_id: number }>(),
      db
        .prepare(
          `SELECT id, post_id, position, label FROM poll_options WHERE post_id IN (${placeholders}) ORDER BY post_id, position`,
        )
        .bind(...ids)
        .all<{ id: number; post_id: number; position: number; label: string }>(),
      db
        .prepare(
          `SELECT o.post_id, v.option_id, COUNT(*) as c
             FROM poll_votes v JOIN poll_options o ON o.id = v.option_id
             WHERE o.post_id IN (${placeholders})
             GROUP BY o.post_id, v.option_id`,
        )
        .bind(...ids)
        .all<{ post_id: number; option_id: number; c: number }>(),
      myVotesPromise,
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
  const pollPostIds = new Set<number>(pollsRes.results.map((p) => p.post_id));
  const optionsByPost = new Map<number, PollOptionPublic[]>();
  for (const o of optionsRes.results) {
    const arr = optionsByPost.get(o.post_id) || [];
    arr.push({ id: o.id, position: o.position, label: o.label, votes: 0 });
    optionsByPost.set(o.post_id, arr);
  }
  // Volcar conteos sobre las opciones ya posicionadas.
  for (const v of voteCountsRes.results) {
    const arr = optionsByPost.get(v.post_id);
    if (!arr) continue;
    const opt = arr.find((o) => o.id === v.option_id);
    if (opt) opt.votes = v.c;
  }
  const myVoteByPost = new Map<number, number>();
  for (const mv of myVotesRes.results) {
    myVoteByPost.set(mv.post_id, mv.option_id);
  }

  // parent_excerpt: snippet de cada padre para los posts que sean reply.
  // En bloque: una query con los parent_ids únicos. NO filtramos deleted_at
  // — queremos saber si el padre está borrado para pintar "en respuesta a un
  // twoitt borrado" en el frontend.
  const parentIds = [
    ...new Set(
      posts
        .map((p) => p.parent_id)
        .filter((pid): pid is number => pid != null),
    ),
  ];
  const parentExcerptByPost = new Map<number, ParentExcerpt>();
  if (parentIds.length > 0) {
    const pPlaceholders = parentIds.map(() => "?").join(",");
    const parentRows = await db
      .prepare(
        `SELECT id, substr(COALESCE(text, ''), 1, 120) AS snippet, deleted_at
           FROM posts WHERE id IN (${pPlaceholders})`,
      )
      .bind(...parentIds)
      .all<{ id: number; snippet: string; deleted_at: string | null }>();
    const byParentId = new Map(parentRows.results.map((r) => [r.id, r]));
    for (const p of posts) {
      if (p.parent_id == null) continue;
      const row = byParentId.get(p.parent_id);
      parentExcerptByPost.set(p.id, {
        id: p.parent_id,
        text_snippet: row?.snippet ?? "",
        deleted: row ? row.deleted_at != null : true,
      });
    }
  }

  return posts.map((p) => {
    let poll: PollPublic | null = null;
    if (pollPostIds.has(p.id)) {
      const options = optionsByPost.get(p.id) || [];
      const total_votes = options.reduce((acc, o) => acc + o.votes, 0);
      poll = {
        options,
        total_votes,
        my_vote_id: myVoteByPost.get(p.id) ?? null,
      };
    }
    return {
      ...p,
      media: mediaByPost.get(p.id) || [],
      hashtags: tagsByPost.get(p.id) || [],
      reply_count: repliesByPost.get(p.id) || 0,
      poll,
      parent_excerpt: parentExcerptByPost.get(p.id) ?? null,
    };
  });
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
  opts: { cursor?: string; tag?: string; q?: string; limit: number; voterId?: string | null },
): Promise<{ posts: Post[]; nextCursor: string | null }> {
  // Cap subido a 500 para soportar el modelo TL "carrete plano" (cargar TODO
  // hasta este tope, luego auto-fetch al llegar cerca del fondo). El cap
  // duro evita queries gigantes si el corpus crece a 10k+.
  const limit = Math.min(500, Math.max(1, opts.limit));
  // Devolvemos TODOS los posts (no solo roots): cada reply es su propio
  // ítem en la TL con header "en respuesta a (…)". El BLOQUE del padre
  // sigue rindiéndose anidado en el frontend usando .replies.
  // deleted_at IS NULL en TODAS las queries de lectura: los borrados
  // siguen en la BD para poder restaurar pero no aparecen en el feed.
  const conds: string[] = ["p.deleted_at IS NULL"];
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

  // Cada post de la página puede ser root de su propio BLOQUE. Traemos los
  // descendientes de TODOS los posts de la página para que las replies
  // anidadas estén disponibles aunque caigan fuera del rango cronológico de
  // la página (caso raro: una reply muy nueva cuyo padre es muy antiguo).
  // Dedup por id porque un descendiente puede estar también en la página.
  // El level cap (256) es defensa contra ciclos accidentales en parent_id o
  // threads patológicamente profundos.
  const pageIds = page.map((p) => p.id);
  const placeholders = pageIds.map(() => "?").join(",");
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
    .bind(...pageIds)
    .all<PostRow>();

  const seenIds = new Set<number>();
  const combined: PostRow[] = [];
  for (const row of [...page, ...descRes.results]) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    combined.push(row);
  }

  const allWithExtras = await attachMediaAndTags(
    db,
    combined,
    opts.voterId ?? null,
  );
  buildReplyTree(allWithExtras);

  // Devolvemos todos los posts de la página en su orden cronológico desc
  // original (no solo roots). Cada uno trae su subárbol en .replies via
  // buildReplyTree para que el frontend pueda renderizar tanto el ítem
  // suelto como su BLOQUE expandido.
  const byId = new Map(allWithExtras.map((p) => [p.id, p]));
  const orderedPosts = page.map((r) => byId.get(r.id)!).filter(Boolean);

  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null;
  return { posts: orderedPosts, nextCursor };
}

export async function getPost(
  db: D1Database,
  id: number,
  voterId: string | null = null,
): Promise<Post | null> {
  const row = await db
    .prepare("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<PostRow>();
  if (!row) return null;
  const [withExtras] = await attachMediaAndTags(db, [row], voterId);
  return withExtras;
}

export async function getReplies(
  db: D1Database,
  parentId: number,
  voterId: string | null = null,
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
  const all = await attachMediaAndTags(db, res.results, voterId);
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
    kind: "image" | "video" | "audio";
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

// Devuelve el primer media de tipo audio de un post. La UI sólo permite 1
// audio por post, así que con el primero basta. Usado por /transcribe para
// localizar el blob a procesar y por el botón "transcribir" para saber si
// hace falta llamar al modelo.
export async function getAudioMediaForPost(
  db: D1Database,
  postId: number,
): Promise<MediaRow | null> {
  const row = await db
    .prepare(
      "SELECT * FROM media WHERE post_id = ? AND kind = 'audio' ORDER BY position ASC, id ASC LIMIT 1",
    )
    .bind(postId)
    .first<MediaRow>();
  return row ?? null;
}

export async function setMediaTranscript(
  db: D1Database,
  mediaId: number,
  transcript: string,
): Promise<void> {
  await db
    .prepare("UPDATE media SET transcript = ? WHERE id = ?")
    .bind(transcript, mediaId)
    .run();
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

  // deleted_at lleva un nonce de 8 hex chars al final del timestamp ISO
  // para que dos borrados en el mismo milisegundo no compartan valor.
  // strftime('%f') es preciso a milisegundos: en bursts (script, retries)
  // dos deletes podían colisionar y un restore traería de vuelta posts de
  // otro borrado. El nonce hace la colisión ~1 en 4e9. Sigue siendo string
  // ordenable por timestamp (el prefijo ISO sigue intacto al inicio).
  await db
    .prepare(
      `UPDATE posts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') || '-' || hex(randomblob(4))
         WHERE id IN (${placeholders})`,
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
  // Restaura sólo los que se borraron en el MISMO momento (mismo deleted_at,
  // incluyendo el nonce — ver deletePost). Antes el match podía resucitar
  // posts de borrados anteriores colisionados al milisegundo.
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
  // Solo posts vivos: el resto de queries (listPosts/getPost/getReplies) filtran
  // deleted_at IS NULL; el export debe respetar el mismo contrato y no sacar
  // contenido de la papelera. media/hashtags/polls cuelgan por post_id, pero al
  // venir los posts ya filtrados, los hijos de posts borrados quedan huérfanos
  // en el JSON sin su post — los excluimos también con un subselect.
  const [posts, media, hashtags, polls, pollOptions, pollVotes] = await Promise.all([
    db.prepare("SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY id").all(),
    db
      .prepare(
        "SELECT * FROM media WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL) ORDER BY post_id, position",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM hashtags WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL) ORDER BY post_id, tag",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM polls WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL) ORDER BY post_id",
      )
      .all(),
    db
      .prepare(
        "SELECT * FROM poll_options WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL) ORDER BY post_id, position",
      )
      .all(),
    // exportamos votos para mantener el dump auto-reproducible. voter_id es
    // un uuid opaco, no PII.
    db
      .prepare(
        "SELECT * FROM poll_votes WHERE post_id IN (SELECT id FROM posts WHERE deleted_at IS NULL) ORDER BY post_id, created_at",
      )
      .all(),
  ]);
  return {
    exported_at: new Date().toISOString(),
    posts: posts.results,
    media: media.results,
    hashtags: hashtags.results,
    polls: polls.results,
    poll_options: pollOptions.results,
    poll_votes: pollVotes.results,
  };
}

// ---------- polls: writes ----------

// Crea la fila de polls y sus opciones para un post recién creado. El
// caller (POST /api/posts) ya validó que options.length >= 2 y que cada
// label no esté vacío y respete el límite de caracteres.
export async function createPoll(
  db: D1Database,
  postId: number,
  options: string[],
): Promise<void> {
  await db
    .prepare("INSERT INTO polls (post_id) VALUES (?)")
    .bind(postId)
    .run();
  const stmt = db.prepare(
    "INSERT INTO poll_options (post_id, position, label) VALUES (?, ?, ?)",
  );
  await db.batch(options.map((label, i) => stmt.bind(postId, i, label)));
}

export type CastVoteResult =
  | { ok: true }
  | { ok: false; error: "no_poll" | "bad_option" | "already_voted" };

// Inserta un voto. Voto INMUTABLE: si ya hay una fila (post_id, voter_id)
// devolvemos `already_voted` sin tocar nada. Validamos que la opción
// pertenezca al post para que un cliente malicioso no pueda votar a una
// opción de otra encuesta.
export async function castVote(
  db: D1Database,
  postId: number,
  voterId: string,
  optionId: number,
): Promise<CastVoteResult> {
  const pollExists = await db
    .prepare("SELECT post_id FROM polls WHERE post_id = ?")
    .bind(postId)
    .first<{ post_id: number }>();
  if (!pollExists) return { ok: false, error: "no_poll" };

  const opt = await db
    .prepare("SELECT id FROM poll_options WHERE id = ? AND post_id = ?")
    .bind(optionId, postId)
    .first<{ id: number }>();
  if (!opt) return { ok: false, error: "bad_option" };

  const existing = await db
    .prepare("SELECT option_id FROM poll_votes WHERE post_id = ? AND voter_id = ?")
    .bind(postId, voterId)
    .first<{ option_id: number }>();
  if (existing) return { ok: false, error: "already_voted" };

  // INSERT OR IGNORE como cinturón + tirantes: si dos requests concurrentes
  // del mismo voter llegan a la vez, una gana por la PK (post_id, voter_id)
  // y la otra cae a 0 filas sin lanzar. Comprobamos `changes` para devolver
  // already_voted en ese caso de carrera.
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO poll_votes (post_id, voter_id, option_id) VALUES (?, ?, ?)",
    )
    .bind(postId, voterId, optionId)
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return { ok: false, error: "already_voted" };
  }
  return { ok: true };
}
