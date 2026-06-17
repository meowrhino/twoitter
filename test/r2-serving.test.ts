// Tests de la ruta pública /r2/* (servir media desde R2). Lo crítico aquí es el
// soporte de HTTP Range: sin 206 + Content-Range el navegador no puede mover la
// barra de un vídeo (seek). Usamos un R2 falso en memoria que parsea el header
// Range igual que R2 real (offset/length y suffix).
import { describe, it, expect } from 'vitest';
import app from '../src/index';

// R2 falso: sólo lo que la ruta usa (get con range, writeHttpMetadata, etc.).
function fakeR2(files: Record<string, { body: Uint8Array; contentType: string }>) {
  return {
    async get(key: string, opts?: { range?: Headers }) {
      const f = files[key];
      if (!f) return null;
      const size = f.body.byteLength;
      const rangeHeader =
        opts?.range instanceof Headers ? opts.range.get('range') : null;

      let range: { offset: number; length: number } | undefined;
      let body = f.body;
      const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (m) {
        const startRaw = m[1];
        const endRaw = m[2];
        let offset: number;
        let length: number;
        if (startRaw === '' && endRaw !== '') {
          // sufijo: últimos N bytes (bytes=-N)
          length = Number(endRaw);
          offset = size - length;
        } else {
          offset = Number(startRaw);
          const end = endRaw === '' ? size - 1 : Number(endRaw);
          length = end - offset + 1;
        }
        range = { offset, length };
        body = f.body.slice(offset, offset + length);
      }

      return {
        size,
        range,
        httpEtag: `"etag-${key}"`,
        body: new Blob([body as BlobPart]).stream(),
        writeHttpMetadata(h: Headers) {
          h.set('content-type', f.contentType);
        },
      };
    },
  } as unknown as R2Bucket;
}

const VIDEO = new Uint8Array(1000).map((_, i) => i % 256);

function makeEnv() {
  return {
    STORAGE: fakeR2({ 'videos/clip.mp4': { body: VIDEO, contentType: 'video/mp4' } }),
  } as unknown as Parameters<typeof app.request>[2];
}

describe('GET /r2/* (servir media con Range)', () => {
  it('sin Range: 200, cuerpo completo, Accept-Ranges: bytes', async () => {
    const res = await app.request('/r2/videos/clip.mp4', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('1000');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(1000);
  });

  it('con Range bytes=0-99: 206 + Content-Range + cuerpo parcial', async () => {
    const res = await app.request(
      '/r2/videos/clip.mp4',
      { headers: { range: 'bytes=0-99' } },
      makeEnv(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(res.headers.get('content-length')).toBe('100');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.byteLength).toBe(100);
  });

  it('con Range en mitad (bytes=500-749): offset correcto', async () => {
    const res = await app.request(
      '/r2/videos/clip.mp4',
      { headers: { range: 'bytes=500-749' } },
      makeEnv(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 500-749/1000');
    expect(res.headers.get('content-length')).toBe('250');
  });

  it('con sufijo (bytes=-50): últimos 50 bytes', async () => {
    const res = await app.request(
      '/r2/videos/clip.mp4',
      { headers: { range: 'bytes=-50' } },
      makeEnv(),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 950-999/1000');
    expect(res.headers.get('content-length')).toBe('50');
  });

  it('clave inexistente: 404', async () => {
    const res = await app.request('/r2/videos/missing.mp4', {}, makeEnv());
    expect(res.status).toBe(404);
  });
});
