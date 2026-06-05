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

describe('legado: /post/:id redirige 301 a /#id', () => {
  it('301 → /#42', async () => {
    const res = await app.request('/post/42', {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/#42');
  });
});
