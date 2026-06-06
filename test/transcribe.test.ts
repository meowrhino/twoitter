// Tests del endpoint POST /api/posts/:id/transcribe vía app.request(path, init, env).
// Cierra la última laguna de cobertura backend (docs/TODO.md): cache, sin-audio,
// blob ausente, fallo de Whisper, transcripción vacía y el flujo OK que persiste.
// AI (Workers AI) y STORAGE (R2) se stubean a mano en el env; el adapter D1
// (better-sqlite3) corre el mismo SQL que producción.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../src/index';
import { makeTestDb } from './helpers/d1';
import { makeToken } from '../src/auth';
import {
  createPost,
  attachMedia,
  getAudioMediaForPost,
  setMediaTranscript,
} from '../src/db';

const SECRET = 'test-secret-1234567890';
const okLimiter = { limit: async () => ({ success: true }) };

// R2 stub: get(key) → objeto con arrayBuffer() + httpMetadata, o null (no existe).
function r2WithBlob(bytes = new Uint8Array([1, 2, 3, 4])) {
  return {
    get: async (_key: string) => ({
      arrayBuffer: async () => bytes.buffer,
      httpMetadata: { contentType: 'audio/webm' },
    }),
  } as unknown as R2Bucket;
}
function r2Empty() {
  return { get: async () => null } as unknown as R2Bucket;
}

function makeEnv(
  db: D1Database,
  { ai, storage }: { ai?: unknown; storage?: R2Bucket } = {},
) {
  return {
    DB: db,
    STORAGE: storage ?? ({} as unknown as R2Bucket),
    ASSETS: {} as unknown as Fetcher,
    AI: ai ?? ({} as unknown),
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

// Inserta un post con un media de audio; si `transcript`, lo deja ya cacheado.
async function postWithAudio(
  db: D1Database,
  { transcript }: { transcript?: string } = {},
) {
  const p = await createPost(db, 'con audio', null);
  await attachMedia(db, p.id, [
    { kind: 'audio', r2_key: 'audios/x.webm', thumb_key: null, width: null, height: null },
  ]);
  if (transcript) {
    const m = await getAudioMediaForPost(db, p.id);
    await setMediaTranscript(db, m!.id, transcript);
  }
  return p;
}

// POST /transcribe autenticado + con header CSRF.
function transcribe(id: number | string, env: ReturnType<typeof makeEnv>, cookie: string) {
  return app.request(`/api/posts/${id}/transcribe`, {
    method: 'POST',
    headers: { 'x-twoitter-csrf': '1', cookie },
  }, env);
}

let db: D1Database;
beforeEach(() => {
  db = makeTestDb();
  // El endpoint loguea su input/output (debug de la cascada de errores de
  // Whisper); silenciar para no ensuciar la salida de los tests.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('POST /api/posts/:id/transcribe — auth/CSRF', () => {
  it('401 sin auth', async () => {
    const res = await app.request('/api/posts/1/transcribe', {
      method: 'POST',
      headers: { 'x-twoitter-csrf': '1' },
    }, makeEnv(db));
    expect(res.status).toBe(401);
  });

  it('403 con auth pero sin header CSRF', async () => {
    const res = await app.request('/api/posts/1/transcribe', {
      method: 'POST',
      headers: { cookie: await authCookie() },
    }, makeEnv(db));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/posts/:id/transcribe — flujo', () => {
  it('400 con id no numérico (incluida basura final como "5abc")', async () => {
    const res = await transcribe('abc', makeEnv(db), await authCookie());
    expect(res.status).toBe(400);
    // parseId estricto: "5abc" ya NO se interpreta como 5 (parseInt lo hacía).
    const res2 = await transcribe('5abc', makeEnv(db), await authCookie());
    expect(res2.status).toBe(400);
  });

  it('404 si el post no tiene audio', async () => {
    const p = await createPost(db, 'sin audio', null);
    const res = await transcribe(p.id, makeEnv(db), await authCookie());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('audio');
  });

  it('200 cached: con transcript ya guardado, devuelve sin tocar el modelo', async () => {
    const ai = { run: vi.fn() };
    const p = await postWithAudio(db, { transcript: 'ya transcrito' });
    const res = await transcribe(p.id, makeEnv(db, { ai, storage: r2WithBlob() }), await authCookie());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, transcript: 'ya transcrito', cached: true });
    expect(ai.run).not.toHaveBeenCalled(); // cache hit → no llama a Whisper
  });

  it('404 si el blob no está en R2', async () => {
    const p = await postWithAudio(db);
    const res = await transcribe(
      p.id, makeEnv(db, { ai: { run: vi.fn() }, storage: r2Empty() }), await authCookie(),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('r2');
  });

  it('500 si Whisper falla', async () => {
    const ai = { run: vi.fn(async () => { throw new Error('boom'); }) };
    const p = await postWithAudio(db);
    const res = await transcribe(p.id, makeEnv(db, { ai, storage: r2WithBlob() }), await authCookie());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('fallo al transcribir');
  });

  it('422 si la transcripción sale vacía (solo whitespace → trim vacío)', async () => {
    const ai = { run: vi.fn(async () => ({ text: '   ' })) };
    const p = await postWithAudio(db);
    const res = await transcribe(p.id, makeEnv(db, { ai, storage: r2WithBlob() }), await authCookie());
    expect(res.status).toBe(422);
  });

  it('200 OK: pasa audio base64 + language a Whisper, trimmea, y persiste (2ª llamada → cached)', async () => {
    const ai = { run: vi.fn(async () => ({ text: '  hola mundo  ' })) };
    const cookie = await authCookie();
    const p = await postWithAudio(db);

    const res = await transcribe(p.id, makeEnv(db, { ai, storage: r2WithBlob() }), cookie);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, transcript: 'hola mundo', cached: false }); // .trim()

    // Whisper recibió el audio como STRING base64 + language 'es'.
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, inputs] = ai.run.mock.calls[0] as [string, { audio: string; language?: string }];
    expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
    expect(typeof inputs.audio).toBe('string');
    expect(inputs.audio.length).toBeGreaterThan(0);
    expect(inputs.language).toBe('es');

    // Persistió: una 2ª llamada (con un AI que tiraría si lo invocaran) → cached.
    const ai2 = { run: vi.fn(async () => { throw new Error('no debería llamarse'); }) };
    const res2 = await transcribe(p.id, makeEnv(db, { ai: ai2, storage: r2WithBlob() }), cookie);
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2).toMatchObject({ transcript: 'hola mundo', cached: true });
    expect(ai2.run).not.toHaveBeenCalled();
  });

  it('acepta también el campo `transcription` del resultado de Whisper', async () => {
    const ai = { run: vi.fn(async () => ({ transcription: 'desde transcription' })) };
    const p = await postWithAudio(db);
    const res = await transcribe(p.id, makeEnv(db, { ai, storage: r2WithBlob() }), await authCookie());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.transcript).toBe('desde transcription');
  });
});
