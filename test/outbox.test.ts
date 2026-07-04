// @vitest-environment happy-dom
//
// Tests de la cola offline (js/outbox.js): encolar posts cuando no hay red
// y publicarlos con flushOutbox. IndexedDB no existe en happy-dom, así que
// stubbeamos una instancia limpia de fake-indexeddb por test.
//
// Los "blobs" de los tests son objetos planos con .size: structured-clone-able
// (los Blob de verdad no sobreviven al clone de Node) y suficientes — el
// flush solo los pasa al uploadFn inyectado, que aquí es un fake.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { queuePost, flushOutbox, outboxCount, outboxSupported } from '../public/js/outbox.js';

// postFn fake: registra las llamadas y responde según el guion (una respuesta
// por llamada; la última se repite si hay más posts que respuestas).
function mockPostFn(...responses: Array<{ ok: boolean; status: number }>) {
  const calls: Array<{ payload: unknown; media: unknown[] }> = [];
  const fn = vi.fn(async (payload: unknown, media: unknown[]) => {
    calls.push({ payload, media });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  });
  return { fn, calls };
}

const okUpload = () =>
  vi.fn(async (_compressed: unknown, kind: string) => ({
    kind,
    r2_key: `fake/${Math.random().toString(36).slice(2)}`,
    thumb_key: null,
    width: null,
    height: null,
  }));

const textEntry = (text: string) => ({
  payload: { text, parent_id: null, location: null, lat: null, lng: null },
  media: [],
});

beforeEach(() => {
  // IDBFactory nueva por test → base de datos limpia, sin fugas entre tests.
  vi.stubGlobal('indexedDB', new IDBFactory());
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('outbox — encolar', () => {
  it('outboxSupported detecta indexedDB', () => {
    expect(outboxSupported()).toBe(true);
  });

  it('queuePost guarda la entrada y outboxCount la cuenta', async () => {
    await queuePost(textEntry('hola'));
    await queuePost(textEntry('mundo'));
    expect(await outboxCount()).toBe(2);
  });

  it('queuePost pinta el chip "📤 N por publicar"', async () => {
    await queuePost(textEntry('pendiente'));
    const chip = document.getElementById('outboxChip');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('📤 1 por publicar');
  });
});

describe('outbox — flush', () => {
  it('publica en orden FIFO y vacía la cola (y quita el chip)', async () => {
    await queuePost(textEntry('primero'));
    await queuePost(textEntry('segundo'));
    const { fn, calls } = mockPostFn({ ok: true, status: 201 });

    const published: number[] = [];
    const res = await flushOutbox({ postFn: fn, onPublished: (n) => published.push(n) });

    expect(res.published).toBe(2);
    expect(await outboxCount()).toBe(0);
    expect(published).toEqual([2]);
    expect((calls[0].payload as { text: string }).text).toBe('primero');
    expect((calls[1].payload as { text: string }).text).toBe('segundo');
    expect(document.getElementById('outboxChip')).toBeNull();
  });

  it('sube los blobs pendientes antes del POST y manda su metadata', async () => {
    await queuePost({
      payload: { text: 'con foto', parent_id: null, location: null, lat: null, lng: null },
      media: [{ kind: 'image', blob: { size: 100 }, thumbBlob: null, width: 10, height: 10 }],
    });
    const uploadFn = okUpload();
    const { fn, calls } = mockPostFn({ ok: true, status: 201 });

    const res = await flushOutbox({ postFn: fn, uploadFn });

    expect(res.published).toBe(1);
    expect(uploadFn).toHaveBeenCalledTimes(1);
    const media = calls[0].media as Array<{ kind: string; r2_key: string }>;
    expect(media[0].kind).toBe('image');
    expect(media[0].r2_key).toMatch(/^fake\//);
  });

  it('la media que ya trae r2_key (item "ready") no se re-sube', async () => {
    await queuePost({
      payload: { text: 'ya subida', parent_id: null, location: null, lat: null, lng: null },
      media: [{ kind: 'image', r2_key: 'images/ya-esta.webp', thumb_key: null, width: 1, height: 1 }],
    });
    const uploadFn = okUpload();
    const { fn, calls } = mockPostFn({ ok: true, status: 201 });

    await flushOutbox({ postFn: fn, uploadFn });

    expect(uploadFn).not.toHaveBeenCalled();
    expect((calls[0].media as Array<{ r2_key: string }>)[0].r2_key).toBe('images/ya-esta.webp');
  });

  it('sin red (status 0): para y lo deja todo en la cola', async () => {
    await queuePost(textEntry('uno'));
    await queuePost(textEntry('dos'));
    const { fn } = mockPostFn({ ok: false, status: 0 });

    const res = await flushOutbox({ postFn: fn });

    expect(res.published).toBe(0);
    expect(await outboxCount()).toBe(2);
    expect(fn).toHaveBeenCalledTimes(1); // paró en el primero
  });

  it('401 (sesión caducada): para SIN descartar nada', async () => {
    await queuePost(textEntry('esperando login'));
    const { fn } = mockPostFn({ ok: false, status: 401 });

    const res = await flushOutbox({ postFn: fn });

    expect(res.published).toBe(0);
    expect(await outboxCount()).toBe(1);
  });

  it('4xx del server: descarta ESE post y sigue con el siguiente', async () => {
    await queuePost(textEntry('rechazado'));
    await queuePost(textEntry('válido'));
    const { fn, calls } = mockPostFn({ ok: false, status: 400 }, { ok: true, status: 201 });

    const res = await flushOutbox({ postFn: fn });

    expect(res.published).toBe(1);
    expect(await outboxCount()).toBe(0); // el 400 se descartó, el otro se publicó
    expect((calls[1].payload as { text: string }).text).toBe('válido');
  });

  it('fallo de red al subir un blob: para y conserva la entrada', async () => {
    await queuePost({
      payload: { text: 'foto sin red', parent_id: null, location: null, lat: null, lng: null },
      media: [{ kind: 'image', blob: { size: 5 }, thumbBlob: null, width: 1, height: 1 }],
    });
    const uploadFn = vi.fn(async () => {
      throw new Error('upload failed: red');
    });
    const { fn } = mockPostFn({ ok: true, status: 201 });

    const res = await flushOutbox({ postFn: fn, uploadFn });

    expect(res.published).toBe(0);
    expect(fn).not.toHaveBeenCalled();
    expect(await outboxCount()).toBe(1);
  });

  it('checkpoint: el blob subido guarda su r2_key y el reintento no lo re-sube', async () => {
    await queuePost({
      payload: { text: 'dos fotos', parent_id: null, location: null, lat: null, lng: null },
      media: [
        { kind: 'image', blob: { size: 1 }, thumbBlob: null, width: 1, height: 1 },
        { kind: 'image', blob: { size: 2 }, thumbBlob: null, width: 2, height: 2 },
      ],
    });
    // 1ª pasada: la primera foto sube, la segunda falla por red.
    let call = 0;
    const flakyUpload = vi.fn(async (_c: unknown, kind: string) => {
      call++;
      if (call === 2) throw new Error('upload failed: red');
      return { kind, r2_key: `images/subida-${call}.webp`, thumb_key: null, width: null, height: null };
    });
    const { fn } = mockPostFn({ ok: true, status: 201 });
    await flushOutbox({ postFn: fn, uploadFn: flakyUpload });
    expect(await outboxCount()).toBe(1);

    // 2ª pasada: solo se sube la que faltaba (1 llamada más, la #3).
    const res = await flushOutbox({ postFn: fn, uploadFn: flakyUpload });
    expect(res.published).toBe(1);
    expect(flakyUpload).toHaveBeenCalledTimes(3);
    expect(await outboxCount()).toBe(0);
  });

  it('413 al subir (demasiado grande): descarta el post entero', async () => {
    await queuePost({
      payload: { text: 'gigante', parent_id: null, location: null, lat: null, lng: null },
      media: [{ kind: 'video', blob: { size: 999 }, thumbBlob: null, width: 1, height: 1 }],
    });
    const uploadFn = vi.fn(async () => {
      throw new Error('upload failed: 413');
    });
    const { fn } = mockPostFn({ ok: true, status: 201 });

    const res = await flushOutbox({ postFn: fn, uploadFn });

    expect(res.published).toBe(0);
    expect(await outboxCount()).toBe(0); // descartado, no se reintenta para siempre
  });
});
