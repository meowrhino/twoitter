// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// state.js calcula POST_ID UNA vez al importar, basándose en location.pathname.
// Para testear distintos paths, hay que cambiar location y reimportar el módulo.
// vi.resetModules() + dynamic import nos permite eso.

describe('POST_ID (state.js)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importWith(pathname: string) {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...window.location, pathname },
    });
    return import('../public/js/state.js');
  }

  it('devuelve null si la URL no es /post/ (timeline)', async () => {
    const { POST_ID, PAGE } = await importWith('/');
    expect(PAGE).toBe('timeline');
    expect(POST_ID).toBeNull();
  });

  it('parsea el id como entero positivo si la URL es /post/42', async () => {
    const { POST_ID, PAGE } = await importWith('/post/42');
    expect(PAGE).toBe('post');
    expect(POST_ID).toBe(42);
  });

  it('devuelve null si el segmento no es un número (/post/abc)', async () => {
    const { POST_ID } = await importWith('/post/abc');
    expect(POST_ID).toBeNull();
  });

  it('devuelve null si el segmento es un número con basura (/post/42abc)', async () => {
    // parseInt('42abc') daría 42, pero queremos rechazarlo para que el
    // server no sufra requests con paths malformados que "casi" funcionan.
    const { POST_ID } = await importWith('/post/42abc');
    expect(POST_ID).toBeNull();
  });

  it('devuelve null si el id es 0 o negativo', async () => {
    expect((await importWith('/post/0')).POST_ID).toBeNull();
    expect((await importWith('/post/-5')).POST_ID).toBeNull();
  });

  it('devuelve null si el segmento está vacío (/post/)', async () => {
    const { POST_ID } = await importWith('/post/');
    expect(POST_ID).toBeNull();
  });
});
