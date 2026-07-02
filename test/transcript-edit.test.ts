// Tests del endpoint PATCH /api/media/:id/transcript — corrección MANUAL de
// una transcripción ya existente. Cubre: auth/CSRF, validación (vacío/límite
// de caracteres), media inexistente/no-audio/sin transcript (404), la 1ª
// corrección congela transcript_original, y correcciones siguientes NO lo
// vuelven a tocar.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { makeTestDb } from './helpers/d1';
import { makeToken } from '../src/auth';
import { createPost, attachMedia, getAudioMediaForPost, setMediaTranscript } from '../src/db';

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

// Inserta un post con un media de audio; si `transcript`, lo deja ya
// transcrito (como si /transcribe ya hubiera corrido). Devuelve el media id.
async function postWithAudio(
  db: D1Database,
  { transcript }: { transcript?: string } = {},
): Promise<number> {
  const p = await createPost(db, 'con audio', null);
  await attachMedia(db, p.id, [
    { kind: 'audio', r2_key: 'audios/x.webm', thumb_key: null, width: null, height: null },
  ]);
  const m = await getAudioMediaForPost(db, p.id);
  if (transcript) await setMediaTranscript(db, m!.id, transcript);
  return m!.id;
}

function editTranscript(
  id: number | string,
  transcript: unknown,
  env: ReturnType<typeof makeEnv>,
  cookie: string,
) {
  return app.request(`/api/media/${id}/transcript`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1', cookie },
    body: JSON.stringify({ transcript }),
  }, env);
}

let db: D1Database;
beforeEach(() => {
  db = makeTestDb();
});

describe('PATCH /api/media/:id/transcript — auth/CSRF', () => {
  it('401 sin auth', async () => {
    const res = await app.request('/api/media/1/transcript', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-twoitter-csrf': '1' },
      body: JSON.stringify({ transcript: 'x' }),
    }, makeEnv(db));
    expect(res.status).toBe(401);
  });

  it('403 con auth pero sin header CSRF', async () => {
    const res = await app.request('/api/media/1/transcript', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: await authCookie() },
      body: JSON.stringify({ transcript: 'x' }),
    }, makeEnv(db));
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/media/:id/transcript — validación y 404', () => {
  it('400 con id no numérico', async () => {
    const res = await editTranscript('abc', 'corregido', makeEnv(db), await authCookie());
    expect(res.status).toBe(400);
  });

  it('400 si el transcript queda vacío (solo whitespace)', async () => {
    const mid = await postWithAudio(db, { transcript: 'original' });
    const res = await editTranscript(mid, '   ', makeEnv(db), await authCookie());
    expect(res.status).toBe(400);
  });

  it('400 si el transcript supera 10000 caracteres', async () => {
    const mid = await postWithAudio(db, { transcript: 'original' });
    const res = await editTranscript(mid, 'x'.repeat(10001), makeEnv(db), await authCookie());
    expect(res.status).toBe(400);
  });

  it('404 si el media no existe', async () => {
    const res = await editTranscript(999, 'corregido', makeEnv(db), await authCookie());
    expect(res.status).toBe(404);
  });

  it('404 si el media no es audio (p.ej. una imagen)', async () => {
    const p = await createPost(db, 'con imagen', null);
    await attachMedia(db, p.id, [
      { kind: 'image', r2_key: 'images/x.webp', thumb_key: null, width: 10, height: 10 },
    ]);
    const { results } = await db
      .prepare('SELECT id FROM media WHERE post_id = ?')
      .bind(p.id)
      .all<{ id: number }>();
    const res = await editTranscript(results[0].id, 'corregido', makeEnv(db), await authCookie());
    expect(res.status).toBe(404);
  });

  it('404 si el audio aún no tiene transcript (nunca se llamó a /transcribe)', async () => {
    const mid = await postWithAudio(db); // sin transcript
    const res = await editTranscript(mid, 'corregido', makeEnv(db), await authCookie());
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/media/:id/transcript — flujo', () => {
  it('200: corrige el transcript, sella transcript_edited_at y preserva el original en la 1ª corrección', async () => {
    const mid = await postWithAudio(db, { transcript: 'texto de whisper' });
    const res = await editTranscript(mid, '  texto corregido  ', makeEnv(db), await authCookie());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transcript).toBe('texto corregido'); // trim
    expect(body.transcript_original).toBe('texto de whisper');
    expect(typeof body.transcript_edited_at).toBe('string');
    expect(body.transcript_edited_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('la 2ª corrección NO sobreescribe transcript_original', async () => {
    const cookie = await authCookie();
    const mid = await postWithAudio(db, { transcript: 'texto de whisper' });
    await editTranscript(mid, 'primera corrección', makeEnv(db), cookie);
    const res2 = await editTranscript(mid, 'segunda corrección', makeEnv(db), cookie);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.transcript).toBe('segunda corrección');
    expect(body2.transcript_original).toBe('texto de whisper'); // intacto
  });
});
