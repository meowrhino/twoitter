// Tests de los endpoints HTTP vía app.request(path, init, env): cubren la capa
// que los tests de db.ts no tocan — auth (requireAuth), CSRF (requireCsrf), el
// rate-limit middleware y el flujo completo de voto. El env lleva el adapter D1
// (better-sqlite3) + stubs de los bindings que las rutas usan.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeTestDb } from './helpers/d1';
import { makeToken } from '../src/auth';
import { createPost, createPoll } from '../src/db';

const SECRET = 'test-secret-1234567890';
const okLimiter = { limit: async () => ({ success: true }) };

function makeEnv(db: D1Database) {
  return {
    DB: db,
    STORAGE: {} as unknown as R2Bucket,
    ASSETS: {} as unknown as Fetcher,
    AI: {} as unknown,
    PASSWORD: 'dev',
    AUTH_SECRET: SECRET,
    VOTE_LIMITER: okLimiter,
    WRITE_LIMITER: okLimiter,
    TRANSCRIBE_LIMITER: okLimiter,
  };
}

async function authCookie() {
  return `twoitter_auth=${await makeToken(SECRET)}`;
}

let db: D1Database;
let env: ReturnType<typeof makeEnv>;
beforeEach(() => {
  db = makeTestDb();
  env = makeEnv(db);
});

describe('POST /api/posts (auth + CSRF)', () => {
  it('401 sin auth', async () => {
    const res = await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1' },
      body: JSON.stringify({ text: 'hola' }),
    }, env);
    expect(res.status).toBe(401);
  });

  it('403 con auth pero sin header CSRF', async () => {
    const res = await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await authCookie() },
      body: JSON.stringify({ text: 'hola' }),
    }, env);
    expect(res.status).toBe(403);
  });

  it('201 con auth + CSRF, y el post queda en el feed', async () => {
    const res = await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ text: 'desde el test' }),
    }, env);
    expect(res.status).toBe(201);

    const feed = await app.request('/api/posts', {}, env).then((r) => r.json());
    expect(feed.posts.some((p: { text: string }) => p.text === 'desde el test')).toBe(true);
  });

  it('400 post vacío', async () => {
    const res = await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({}),
    }, env);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/posts/:id/poll/vote', () => {
  it('flujo de voto: sin CSRF 403, voto OK 200, doble voto 409', async () => {
    const p = await createPost(db, '¿cuál?', null);
    await createPoll(db, p.id, ['sí', 'no']);
    const detail = await app.request(`/api/posts/${p.id}`, {}, env).then((r) => r.json());
    const optId = detail.post.poll.options[0].id;

    // sin CSRF → 403
    const noCsrf = await app.request(`/api/posts/${p.id}/poll/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ option_id: optId }),
    }, env);
    expect(noCsrf.status).toBe(403);

    // con CSRF → 200 y emite cookie tv_id
    const vote1 = await app.request(`/api/posts/${p.id}/poll/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1' },
      body: JSON.stringify({ option_id: optId }),
    }, env);
    expect(vote1.status).toBe(200);
    const tvCookie = (vote1.headers.get('set-cookie') || '').split(';')[0];
    expect(tvCookie).toContain('tv_id=');

    // segundo voto con la misma cookie → 409 (voto inmutable)
    const vote2 = await app.request(`/api/posts/${p.id}/poll/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: tvCookie },
      body: JSON.stringify({ option_id: optId }),
    }, env);
    expect(vote2.status).toBe(409);
  });

  it('404 votar en un post sin encuesta', async () => {
    const p = await createPost(db, 'sin encuesta', null);
    const res = await app.request(`/api/posts/${p.id}/poll/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1' },
      body: JSON.stringify({ option_id: 1 }),
    }, env);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/places (sitios guardados)', () => {
  it('401 sin auth', async () => {
    const res = await app.request('/api/places', {}, env);
    expect(res.status).toBe(401);
  });

  it('200 + array authed; refleja los sitios auto-guardados al publicar', async () => {
    await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ text: 'con sitio', location: 'Girona', lat: 41.98, lng: 2.82 }),
    }, env);
    const res = await app.request('/api/places', { headers: { cookie: await authCookie() } }, env);
    expect(res.status).toBe(200);
    const places = await res.json();
    expect(places.some((p: { name: string }) => p.name === 'Girona')).toBe(true);
  });
});

describe('PATCH / DELETE /api/places/:id', () => {
  async function seedPlace() {
    await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ text: 'sitio', location: 'Sitio', lat: 41.5, lng: 2.5 }),
    }, env);
    const places = await app.request('/api/places', { headers: { cookie: await authCookie() } }, env).then((r) => r.json());
    return places[0].id as number;
  }

  it('401 sin auth (PATCH y DELETE)', async () => {
    const patch = await app.request('/api/places/1', {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1' }, body: JSON.stringify({ name: 'x' }),
    }, env);
    expect(patch.status).toBe(401);
    const del = await app.request('/api/places/1', { method: 'DELETE', headers: { 'x-twoitter-csrf': '1' } }, env);
    expect(del.status).toBe(401);
  });

  it('403 sin header CSRF', async () => {
    const res = await app.request('/api/places/1', {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: await authCookie() }, body: JSON.stringify({ name: 'x' }),
    }, env);
    expect(res.status).toBe(403);
  });

  it('PATCH renombra un sitio existente (200)', async () => {
    const id = await seedPlace();
    const res = await app.request(`/api/places/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ name: 'Sitio renombrado', radius: 250 }),
    }, env);
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Sitio renombrado');
    expect(updated.radius).toBe(250);
  });

  it('PATCH 400 con nombre vacío', async () => {
    const id = await seedPlace();
    const res = await app.request(`/api/places/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ name: '   ' }),
    }, env);
    expect(res.status).toBe(400);
  });

  it('DELETE borra (200) y luego 404', async () => {
    const id = await seedPlace();
    const del = await app.request(`/api/places/${id}`, { method: 'DELETE', headers: { 'x-twoitter-csrf': '1', cookie: await authCookie() } }, env);
    expect(del.status).toBe(200);
    const again = await app.request(`/api/places/${id}`, { method: 'DELETE', headers: { 'x-twoitter-csrf': '1', cookie: await authCookie() } }, env);
    expect(again.status).toBe(404);
  });
});

describe('legado: /post/:id redirige 301 a /#id', () => {
  it('301 → /#42', async () => {
    const res = await app.request('/post/42', {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/#42');
  });
});

describe('POST /api/posts con ubicación', () => {
  it('etiqueta sin coords → location set, lat/lng null (no link espurio a 0,0)', async () => {
    await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ text: 'con sitio', location: 'el bar', lat: null, lng: null }),
    }, env);
    const feed = await app.request('/api/posts', {}, env).then((r) => r.json());
    const p = feed.posts.find((x: { text: string }) => x.text === 'con sitio');
    expect(p.location).toBe('el bar');
    expect(p.lat).toBeNull();
    expect(p.lng).toBeNull();
  });

  it('coords válidas → se persisten', async () => {
    await app.request('/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie: await authCookie() },
      body: JSON.stringify({ text: 'con gps', location: 'Girona', lat: 41.98, lng: 2.82 }),
    }, env);
    const feed = await app.request('/api/posts', {}, env).then((r) => r.json());
    const p = feed.posts.find((x: { text: string }) => x.text === 'con gps');
    expect(p.location).toBe('Girona');
    expect(p.lat).toBeCloseTo(41.98);
    expect(p.lng).toBeCloseTo(2.82);
  });
});

