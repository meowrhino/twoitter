// Tests de backend de src/db.ts contra una D1 real-ish (better-sqlite3 con el
// schema completo). Cubren la lógica que más cambió esta sesión: el carrete
// plano (listPosts devuelve roots + replies), parent_excerpt, cursor, getReplies,
// encuestas (createPoll/castVote) y el soft-delete en cascada + restore.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './helpers/d1';
import {
  attachMedia,
  createPost,
  getPost,
  listPosts,
  getReplies,
  createPoll,
  castVote,
  createLyrics,
  deletePost,
  restorePost,
  listHashtags,
  exportAll,
  createPlace,
  listPlaces,
  findNearbyPlace,
  updatePlace,
  deletePlace,
} from '../src/db';
import { syncHashtags } from '../src/hashtags';

let db: D1Database;
beforeEach(() => {
  db = makeTestDb();
});

describe('createPost + getPost', () => {
  it('crea un post y lo recupera con extras vacíos', async () => {
    const created = await createPost(db, 'hola mundo', null);
    expect(created.id).toBeGreaterThan(0);
    const got = await getPost(db, created.id);
    expect(got).not.toBeNull();
    expect(got!.text).toBe('hola mundo');
    expect(got!.parent_id).toBeNull();
    expect(got!.media).toEqual([]);
    expect(got!.hashtags).toEqual([]);
    expect(got!.reply_count).toBe(0);
    expect(got!.poll).toBeNull();
  });

  it('getPost devuelve null para id inexistente o borrado', async () => {
    expect(await getPost(db, 9999)).toBeNull();
  });

  it('persiste y devuelve ubicación (etiqueta + coords)', async () => {
    const created = await createPost(db, 'desde la playa', null, 'Barcelona, España', 41.3851, 2.1734);
    const got = await getPost(db, created.id);
    expect(got!.location).toBe('Barcelona, España');
    expect(got!.lat).toBeCloseTo(41.3851);
    expect(got!.lng).toBeCloseTo(2.1734);
  });

  it('post sin ubicación deja location/lat/lng en null', async () => {
    const created = await createPost(db, 'sin lugar', null);
    const got = await getPost(db, created.id);
    expect(got!.location).toBeNull();
    expect(got!.lat).toBeNull();
    expect(got!.lng).toBeNull();
  });

  it('las replies arrastran su ubicación por el CTE de getReplies', async () => {
    const root = await createPost(db, 'root', null);
    await createPost(db, 'reply con sitio', root.id, 'casa', null, null);
    const replies = await getReplies(db, root.id);
    expect(replies[0].location).toBe('casa');
  });
});

describe('places (sitios guardados / geofence)', () => {
  it('createPlace + listPlaces round-trip con radio por defecto 150', async () => {
    const p = await createPlace(db, 'casa', 41.3851, 2.1734);
    expect(p.id).toBeGreaterThan(0);
    expect(p.radius).toBe(150);
    const all = await listPlaces(db);
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('casa');
  });

  it('findNearbyPlace encuentra un sitio a ~44 m y NO a ~555 m', async () => {
    await createPlace(db, 'casa', 41.3851, 2.1734); // radio 150
    const near = await findNearbyPlace(db, 41.3855, 2.1734); // ~44 m
    expect(near?.name).toBe('casa');
    const far = await findNearbyPlace(db, 41.3901, 2.1734); // ~555 m
    expect(far).toBeNull();
  });

  it('findNearbyPlace devuelve null sin sitios guardados', async () => {
    expect(await findNearbyPlace(db, 41.3851, 2.1734)).toBeNull();
  });

  it('createPlace stampa owner (default "me")', async () => {
    const p = await createPlace(db, 'casa', 41.3851, 2.1734);
    expect(p.owner).toBe('me');
  });

  it('updatePlace renombra y ajusta radio si eres el dueño', async () => {
    const p = await createPlace(db, 'casa', 41.3851, 2.1734);
    const up = await updatePlace(db, p.id, { name: 'mi casa', radius: 300 }, 'me');
    expect(up?.name).toBe('mi casa');
    expect(up?.radius).toBe(300);
  });

  it('updatePlace devuelve null si no eres el dueño', async () => {
    const p = await createPlace(db, 'casa', 41.3851, 2.1734); // owner 'me'
    const up = await updatePlace(db, p.id, { name: 'hack', radius: 150 }, 'otro');
    expect(up).toBeNull();
    // y no se modificó
    expect((await listPlaces(db))[0].name).toBe('casa');
  });

  it('deletePlace borra si eres el dueño, no si no lo eres', async () => {
    const p = await createPlace(db, 'casa', 41.3851, 2.1734);
    expect(await deletePlace(db, p.id, 'otro')).toBe(false);
    expect(await listPlaces(db)).toHaveLength(1);
    expect(await deletePlace(db, p.id, 'me')).toBe(true);
    expect(await listPlaces(db)).toHaveLength(0);
  });
});

describe('listPosts (carrete plano)', () => {
  it('devuelve roots Y replies como ítems propios, cron desc', async () => {
    const a = await createPost(db, 'root A', null);
    const b = await createPost(db, 'reply a A', a.id);
    const c = await createPost(db, 'root C', null);

    const { posts } = await listPosts(db, { limit: 50 });
    const ids = posts.map((p) => p.id);
    // los 3 aparecen (incluida la reply b) — carrete plano
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    // cron desc con desempate por id: el último creado va primero
    expect(ids[0]).toBe(c.id);
  });

  it('la reply lleva parent_excerpt con el snippet del padre', async () => {
    const a = await createPost(db, 'el padre original', null);
    const b = await createPost(db, 'la respuesta', a.id);
    const { posts } = await listPosts(db, { limit: 50 });
    const reply = posts.find((p) => p.id === b.id)!;
    expect(reply.parent_excerpt).toBeTruthy();
    expect(reply.parent_excerpt!.id).toBe(a.id);
    expect(reply.parent_excerpt!.text_snippet).toBe('el padre original');
    expect(reply.parent_excerpt!.deleted).toBe(false);
  });

  it('parent_excerpt marca deleted cuando el padre está borrado', async () => {
    const a = await createPost(db, 'padre a borrar', null);
    const b = await createPost(db, 'reply huérfana', a.id);
    // Borramos SÓLO el padre, directo por SQL: deletePost cascadearía al hijo,
    // y restorePost reviviría el batch entero. Así aislamos "reply viva, padre
    // muerto" (puede pasar en la BD aunque la API normal lo evite).
    await db
      .prepare('UPDATE posts SET deleted_at = ? WHERE id = ?')
      .bind('2026-01-01T00:00:00.000Z-deadbeef', a.id)
      .run();
    const { posts } = await listPosts(db, { limit: 50 });
    const reply = posts.find((p) => p.id === b.id);
    expect(reply).toBeTruthy();
    expect(reply!.parent_excerpt!.deleted).toBe(true);
  });

  it('el cursor pagina sin repetir ni saltarse posts', async () => {
    const created = [];
    for (let i = 0; i < 5; i++) created.push(await createPost(db, `post ${i}`, null));
    const page1 = await listPosts(db, { limit: 2 });
    expect(page1.posts).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listPosts(db, { limit: 2, cursor: page1.nextCursor! });
    const seen = new Set([...page1.posts, ...page2.posts].map((p) => p.id));
    expect(seen.size).toBe(4); // 2 + 2 distintos
  });

  it('filtra por texto (q)', async () => {
    await createPost(db, 'manzana', null);
    await createPost(db, 'banana', null);
    const { posts } = await listPosts(db, { limit: 50, q: 'manz' });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe('manzana');
  });

  it('q > 200 chars se trunca, NO devuelve el feed entero (regresión)', async () => {
    await createPost(db, 'manzana', null);
    await createPost(db, 'banana', null);
    // Antes: con q.length > 200 el filtro LIKE se descartaba → devolvía TODO.
    // Ahora se trunca a 200; este patrón no aparece en ningún texto → 0 resultados.
    const huge = 'z'.repeat(300);
    const { posts } = await listPosts(db, { limit: 50, q: huge });
    expect(posts).toHaveLength(0);
  });
});

describe('listPosts filtra por type', () => {
  function img() {
    return { kind: 'image' as const, r2_key: 'k.jpg', thumb_key: null, width: null, height: null };
  }

  it('type=image devuelve solo posts con media de ese kind', async () => {
    const withImg = await createPost(db, 'con imagen', null);
    await attachMedia(db, withImg.id, [img()]);
    const withoutImg = await createPost(db, 'sin imagen', null);
    const { posts } = await listPosts(db, { limit: 50, type: 'image' });
    const ids = posts.map((p) => p.id);
    expect(ids).toContain(withImg.id);
    expect(ids).not.toContain(withoutImg.id);
  });

  it('type=poll devuelve solo posts con encuesta', async () => {
    const withPoll = await createPost(db, '¿cuál?', null);
    await createPoll(db, withPoll.id, ['a', 'b']);
    const withoutPoll = await createPost(db, 'normal', null);
    const { posts } = await listPosts(db, { limit: 50, type: 'poll' });
    const ids = posts.map((p) => p.id);
    expect(ids).toContain(withPoll.id);
    expect(ids).not.toContain(withoutPoll.id);
  });

  it('type=lyrics devuelve solo posts con letras', async () => {
    const withLyrics = await createPost(db, 'una canción', null);
    await createLyrics(db, withLyrics.id, null, [{ label: 'original', text: 'x' }]);
    const withoutLyrics = await createPost(db, 'normal', null);
    const { posts } = await listPosts(db, { limit: 50, type: 'lyrics' });
    const ids = posts.map((p) => p.id);
    expect(ids).toContain(withLyrics.id);
    expect(ids).not.toContain(withoutLyrics.id);
  });

  it('un post con varios tipos aparece en cada filtro correspondiente', async () => {
    const multi = await createPost(db, 'con todo', null);
    await attachMedia(db, multi.id, [img()]);
    await createPoll(db, multi.id, ['a', 'b']);
    await createLyrics(db, multi.id, null, [{ label: 'original', text: 'x' }]);
    for (const type of ['image', 'poll', 'lyrics'] as const) {
      const { posts } = await listPosts(db, { limit: 50, type });
      expect(posts.map((p) => p.id)).toContain(multi.id);
    }
    const { posts: videoPosts } = await listPosts(db, { limit: 50, type: 'video' });
    expect(videoPosts.map((p) => p.id)).not.toContain(multi.id);
  });
});

describe('getReplies', () => {
  it('devuelve el subárbol de un post (replies directas)', async () => {
    const a = await createPost(db, 'root', null);
    const b = await createPost(db, 'reply 1', a.id);
    await createPost(db, 'sub-reply', b.id); // nieto
    const replies = await getReplies(db, a.id);
    // getReplies filtra a las directas de a; el nieto cuelga de b.replies
    expect(replies.map((r) => r.id)).toEqual([b.id]);
    expect(replies[0].replies!.map((r) => r.text)).toEqual(['sub-reply']);
  });
});

describe('encuestas: createPoll + castVote', () => {
  async function postWithPoll() {
    const p = await createPost(db, '¿cuál?', null);
    await createPoll(db, p.id, ['sí', 'no']);
    const full = await getPost(db, p.id);
    return { postId: p.id, options: full!.poll!.options };
  }

  it('getPost arma la encuesta con opciones y 0 votos', async () => {
    const { options } = await postWithPoll();
    expect(options.map((o) => o.label)).toEqual(['sí', 'no']);
    expect(options.every((o) => o.votes === 0)).toBe(true);
  });

  it('primer voto OK y suma el conteo', async () => {
    const { postId, options } = await postWithPoll();
    const res = await castVote(db, postId, 'voter-1', options[0].id);
    expect(res.ok).toBe(true);
    const full = await getPost(db, postId, 'voter-1');
    expect(full!.poll!.total_votes).toBe(1);
    expect(full!.poll!.my_vote_id).toBe(options[0].id);
  });

  it('voto inmutable: segundo voto del mismo votante → already_voted', async () => {
    const { postId, options } = await postWithPoll();
    await castVote(db, postId, 'voter-1', options[0].id);
    const second = await castVote(db, postId, 'voter-1', options[1].id);
    expect(second).toEqual({ ok: false, error: 'already_voted' });
    const full = await getPost(db, postId, 'voter-1');
    expect(full!.poll!.total_votes).toBe(1); // no subió
  });

  it('opción de otra encuesta → bad_option', async () => {
    const { postId } = await postWithPoll();
    const res = await castVote(db, postId, 'voter-x', 99999);
    expect(res).toEqual({ ok: false, error: 'bad_option' });
  });

  it('post sin encuesta → no_poll', async () => {
    const p = await createPost(db, 'sin encuesta', null);
    const res = await castVote(db, p.id, 'voter-x', 1);
    expect(res).toEqual({ ok: false, error: 'no_poll' });
  });

  it('dos votantes distintos suman 2', async () => {
    const { postId, options } = await postWithPoll();
    await castVote(db, postId, 'voter-1', options[0].id);
    await castVote(db, postId, 'voter-2', options[1].id);
    const full = await getPost(db, postId);
    expect(full!.poll!.total_votes).toBe(2);
  });
});

describe('lyrics: createLyrics', () => {
  it('getPost arma los bloques en orden con su fuente', async () => {
    const p = await createPost(db, 'una canción', null);
    await createLyrics(db, p.id, 'https://example.com/song', [
      { label: 'original', text: 'línea uno' },
      { label: 'romaji', text: 'linea uno romanizada' },
    ]);
    const got = await getPost(db, p.id);
    expect(got!.lyrics!.source).toBe('https://example.com/song');
    expect(got!.lyrics!.blocks.map((b) => b.label)).toEqual(['original', 'romaji']);
    expect(got!.lyrics!.blocks.map((b) => b.text)).toEqual(['línea uno', 'linea uno romanizada']);
  });

  it('post sin lyrics → lyrics null', async () => {
    const p = await createPost(db, 'sin letras', null);
    const got = await getPost(db, p.id);
    expect(got!.lyrics).toBeNull();
  });

  it('fuente null si no se pasa', async () => {
    const p = await createPost(db, 'otra canción', null);
    await createLyrics(db, p.id, null, [{ label: 'original', text: 'texto' }]);
    const got = await getPost(db, p.id);
    expect(got!.lyrics!.source).toBeNull();
  });
});

describe('deletePost (soft-delete en cascada) + restorePost', () => {
  it('borra el post y sus descendientes, y desaparecen del feed', async () => {
    const a = await createPost(db, 'root', null);
    const b = await createPost(db, 'reply', a.id);
    const c = await createPost(db, 'sub-reply', b.id);
    const otro = await createPost(db, 'no relacionado', null);

    const res = await deletePost(db, a.id);
    expect(res).not.toBeNull();
    expect(new Set(res!.softDeletedIds)).toEqual(new Set([a.id, b.id, c.id]));

    const { posts } = await listPosts(db, { limit: 50 });
    const ids = posts.map((p) => p.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    expect(ids).toContain(otro.id); // el no relacionado sigue
  });

  it('restorePost revive el subárbol borrado en el mismo batch', async () => {
    const a = await createPost(db, 'root', null);
    const b = await createPost(db, 'reply', a.id);
    await deletePost(db, a.id);
    const restored = await restorePost(db, a.id);
    expect(new Set(restored!.restoredIds)).toEqual(new Set([a.id, b.id]));
    const { posts } = await listPosts(db, { limit: 50 });
    const ids = posts.map((p) => p.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('deletePost de un id inexistente devuelve null', async () => {
    expect(await deletePost(db, 9999)).toBeNull();
  });
});

describe('hashtags', () => {
  it('syncHashtags inserta y listHashtags los cuenta', async () => {
    const a = await createPost(db, 'hola #tech y #spain', null);
    await syncHashtags(db, a.id, 'hola #tech y #spain');
    const b = await createPost(db, 'otro #tech', null);
    await syncHashtags(db, b.id, 'otro #tech');
    const tags = await listHashtags(db);
    const byTag = Object.fromEntries(tags.map((t) => [t.tag, t.count]));
    expect(byTag.tech).toBe(2);
    expect(byTag.spain).toBe(1);
  });

  it('syncHashtags reemplaza los del post (no acumula)', async () => {
    const a = await createPost(db, '#uno', null);
    await syncHashtags(db, a.id, '#uno');
    await syncHashtags(db, a.id, '#dos'); // re-sync con otro tag
    const tags = (await listHashtags(db)).map((t) => t.tag);
    expect(tags).toContain('dos');
    expect(tags).not.toContain('uno');
  });
});

describe('exportAll', () => {
  it('excluye posts borrados y sus hijos huérfanos', async () => {
    const vivo = await createPost(db, 'vivo', null);
    const muerto = await createPost(db, 'a borrar', null);
    await deletePost(db, muerto.id);
    const dump = await exportAll(db);
    const ids = dump.posts.map((p: { id: number }) => p.id);
    expect(ids).toContain(vivo.id);
    expect(ids).not.toContain(muerto.id);
  });

  it('incluye lyrics y lyrics_blocks de posts vivos', async () => {
    const p = await createPost(db, 'con letras', null);
    await createLyrics(db, p.id, null, [{ label: 'original', text: 'texto' }]);
    const dump = await exportAll(db);
    expect(dump.lyrics.map((l: { post_id: number }) => l.post_id)).toContain(p.id);
    expect(dump.lyrics_blocks.map((b: { post_id: number }) => b.post_id)).toContain(p.id);
  });
});

describe('chunking lógico (selectByIds con >90 posts)', () => {
  it('listPosts arma bien media/replies con muchos posts (>1 lote)', async () => {
    // 95 roots → fuerza >1 lote en las IN-queries de attachMediaAndTags.
    // (better-sqlite3 no impone el tope de params de D1, pero verifica que
    // la lógica de troceado + dedup no pierde ni duplica filas.)
    const ids = [];
    for (let i = 0; i < 95; i++) ids.push((await createPost(db, `bulk ${i}`, null)).id);
    const { posts } = await listPosts(db, { limit: 100 });
    expect(posts).toHaveLength(95);
    expect(new Set(posts.map((p) => p.id)).size).toBe(95); // sin duplicados
  });
});
