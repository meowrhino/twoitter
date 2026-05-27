// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../public/js/api.js';

// El wrapper api() lee CSRF_HEADERS de state.js. Como el módulo es ES, los
// tests reciben el objeto real, no podemos remockearlo. La cookie de sesión
// la mete el browser; aquí sólo verificamos que la llamada usa el header correcto.

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('api()', () => {
  it('GET por defecto, sin CSRF, sin content-type', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await api('/api/foo');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ ok: 1 });
    const [path, opts] = spy.mock.calls[0];
    expect(path).toBe('/api/foo');
    expect(opts!.method).toBe('GET');
    expect(opts!.credentials).toBe('same-origin');
    expect((opts!.headers as Record<string, string>)['x-twoitter-csrf']).toBeUndefined();
    expect((opts!.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('POST con body objeto: serializa JSON y mete CSRF + content-type', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"id":1}', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const result = await api('/api/foo', { method: 'POST', body: { x: 1 } });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 1 });
    const opts = spy.mock.calls[0][1]!;
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-twoitter-csrf']).toBe('1');
    expect(headers['content-type']).toBe('application/json');
    expect(opts.body).toBe('{"x":1}');
  });

  it('DELETE: mete CSRF pero NO content-type (sin body)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 204 }),
    );
    await api('/api/foo/1', { method: 'DELETE' });
    const opts = spy.mock.calls[0][1]!;
    const headers = opts.headers as Record<string, string>;
    expect(headers['x-twoitter-csrf']).toBe('1');
    expect(headers['content-type']).toBeUndefined();
  });

  it('POST con Blob: pasa raw sin JSON.stringify y respeta content-type del caller', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await api('/api/upload', { method: 'POST', body: blob, headers: { 'content-type': 'image/png' } });
    const opts = spy.mock.calls[0][1]!;
    // body no se serializó (sigue siendo Blob)
    expect(opts.body).toBe(blob);
    const headers = opts.headers as Record<string, string>;
    // El caller sobrescribe content-type por encima del que el wrapper habría puesto
    expect(headers['content-type']).toBe('image/png');
    expect(headers['x-twoitter-csrf']).toBe('1');
  });

  it('captura errores de red sin lanzar y devuelve ok:false, status:0', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const result = await api('/api/foo');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
  });

  it('devuelve ok:false con status real cuando el server responde 4xx/5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"nope"}', { status: 422, headers: { 'content-type': 'application/json' } }),
    );
    const result = await api('/api/foo', { method: 'POST', body: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(422);
    expect(result.data).toEqual({ error: 'nope' });
  });

  it('devuelve data:null cuando el body no es JSON válido', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 500 }),
    );
    const result = await api('/api/foo');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.data).toBeNull();
  });

  it('soporta query string en la path', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await api('/api/posts?tag=foo&limit=10');
    expect(spy.mock.calls[0][0]).toBe('/api/posts?tag=foo&limit=10');
  });
});
