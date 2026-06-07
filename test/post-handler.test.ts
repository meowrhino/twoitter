// Tests de la validación + persistencia del POST /api/posts, extraídas a
// validatePostBody() y persistPost() en src/index.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from './helpers/d1';
import { validatePostBody, persistPost } from '../src/index';
import { createPost, getPost, listPlaces } from '../src/db';

// Helper: persistPost requiere los campos de ubicación; los defaulteamos a null
// para no repetirlos en cada caso que no los testea.
function pp(over: Record<string, unknown> = {}) {
  return { text: null, media: [], pollOptions: null, parentId: null, location: null, lat: null, lng: null, ...over } as Parameters<typeof persistPost>[1];
}

let db: D1Database;
beforeEach(() => {
  db = makeTestDb();
});

describe('validatePostBody', () => {
  it('rechaza un post vacío (sin texto, media ni encuesta)', async () => {
    const r = await validatePostBody(db, {});
    expect(r).toMatchObject({ ok: false, status: 400, error: 'post vacio' });
  });

  it('rechaza texto > 4000 chars', async () => {
    const r = await validatePostBody(db, { text: 'x'.repeat(4001) });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rechaza encuesta con menos de 2 opciones', async () => {
    const r = await validatePostBody(db, { poll: { options: ['solo una'] } });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rechaza más de 12 adjuntos', async () => {
    const media = Array.from({ length: 13 }, () => ({ kind: 'image' as const, r2_key: 'k' }));
    const r = await validatePostBody(db, { text: 'x', media });
    expect(r).toMatchObject({ ok: false, error: 'demasiados adjuntos' });
  });

  it('rechaza media con kind inválido o sin r2_key', async () => {
    const bad1 = await validatePostBody(db, { media: [{ kind: 'gif' as never, r2_key: 'k' }] });
    expect(bad1).toMatchObject({ ok: false });
    const bad2 = await validatePostBody(db, { media: [{ kind: 'image', r2_key: '' }] });
    expect(bad2).toMatchObject({ ok: false });
  });

  it('rechaza parent inexistente con 404', async () => {
    const r = await validatePostBody(db, { text: 'reply', parent_id: 9999 });
    expect(r).toMatchObject({ ok: false, status: 404, error: 'parent no existe' });
  });

  it('acepta un post válido y normaliza la media (nulls)', async () => {
    const r = await validatePostBody(db, {
      text: '  hola  ',
      media: [{ kind: 'image', r2_key: 'img.jpg' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('hola'); // trim
      expect(r.media[0]).toEqual({ kind: 'image', r2_key: 'img.jpg', thumb_key: null, width: null, height: null });
      expect(r.pollOptions).toBeNull();
    }
  });

  it('acepta encuesta válida y recorta opciones vacías', async () => {
    const r = await validatePostBody(db, { poll: { options: ['sí', '  ', 'no'] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pollOptions).toEqual(['sí', 'no']);
  });

  it('acepta reply a un parent que sí existe', async () => {
    const parent = await createPost(db, 'padre', null);
    const r = await validatePostBody(db, { text: 'reply', parent_id: parent.id });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parentId).toBe(parent.id);
  });

  it('rechaza reply a un parent BORRADO (404)', async () => {
    const parent = await createPost(db, 'a borrar', null);
    await db
      .prepare('UPDATE posts SET deleted_at = ? WHERE id = ?')
      .bind('2026-01-01T00:00:00.000Z-x', parent.id)
      .run();
    const r = await validatePostBody(db, { text: 'reply', parent_id: parent.id });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe('persistPost', () => {
  it('crea el post y queda recuperable por getPost', async () => {
    const id = await persistPost(db, { text: 'persistido', media: [], pollOptions: null, parentId: null });
    const got = await getPost(db, id);
    expect(got!.text).toBe('persistido');
  });

  it('crea la encuesta cuando hay pollOptions', async () => {
    const id = await persistPost(db, pp({ text: '¿cuál?', pollOptions: ['a', 'b'] }));
    const got = await getPost(db, id);
    expect(got!.poll!.options.map((o) => o.label)).toEqual(['a', 'b']);
  });
});

describe('persistPost — geofence (auto-save de sitios)', () => {
  it('auto-guarda un sitio cuando el post trae nombre + coords', async () => {
    await persistPost(db, pp({ text: 'en la playa', location: 'Barceloneta', lat: 41.3784, lng: 2.1925 }));
    const places = await listPlaces(db);
    expect(places).toHaveLength(1);
    expect(places[0].name).toBe('Barceloneta');
  });

  it('NO duplica un sitio dentro del radio (150 m), aunque el nombre cambie', async () => {
    await persistPost(db, pp({ text: 'a', location: 'casa', lat: 41.3851, lng: 2.1734 }));
    await persistPost(db, pp({ text: 'b', location: 'mi casa', lat: 41.3855, lng: 2.1734 })); // ~44 m
    expect(await listPlaces(db)).toHaveLength(1);
  });

  it('crea un 2º sitio si está fuera del radio', async () => {
    await persistPost(db, pp({ text: 'a', location: 'casa', lat: 41.3851, lng: 2.1734 }));
    await persistPost(db, pp({ text: 'b', location: 'oficina', lat: 41.3901, lng: 2.1734 })); // ~555 m
    expect(await listPlaces(db)).toHaveLength(2);
  });

  it('NO guarda sitio si hay coords pero no nombre', async () => {
    await persistPost(db, pp({ text: 'solo coords', lat: 41.3851, lng: 2.1734 }));
    expect(await listPlaces(db)).toHaveLength(0);
  });

  it('NO guarda sitio si hay nombre pero no coords', async () => {
    await persistPost(db, pp({ text: 'solo etiqueta', location: 'algun sitio' }));
    expect(await listPlaces(db)).toHaveLength(0);
  });
});
