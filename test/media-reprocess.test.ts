// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mockeamos el barril del compresor: nada de ffmpeg/canvas reales. Cada función
// devuelve un blob falso del tipo esperado para poder verificar el flujo de
// reprocessItem (estado + swap del preview) en jsdom.
vi.mock('../public/js/compressor.js', () => ({
  compressImage: vi.fn(async (_file: unknown, editParams: unknown) => ({
    blob: new Blob(['webp'], { type: 'image/webp' }),
    width: 100,
    height: 80,
    _editParams: editParams,
  })),
  compressVideo: vi.fn(async () => ({
    blob: new Blob(['v'], { type: 'video/webm' }),
    width: 100,
    height: 100,
    duration: 2,
  })),
  generateVideoThumb: vi.fn(async () => ({
    blob: new Blob(['t'], { type: 'image/jpeg' }),
    width: 48,
    height: 48,
  })),
  trimAudio: vi.fn(async () => ({
    blob: new Blob(['a'], { type: 'audio/ogg' }),
    width: null,
    height: null,
  })),
  detectCapabilities: vi.fn(() => ({ ok: true })),
}));

import { reprocessItem } from '../public/js/media.js';
import { createPreviewItem } from '../public/js/preview-item.js';

beforeAll(() => {
  // happy-dom puede no traer createObjectURL; stub mínimo determinista.
  if (typeof URL.createObjectURL !== 'function') {
    let n = 0;
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => `blob:fake-${n++}`;
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(kind: 'image' | 'video' | 'audio') {
  const previewRoot = document.createElement('div');
  const itemEl = createPreviewItem({ localId: 'x1', previewUrl: 'blob:orig', kind });
  previewRoot.appendChild(itemEl);
  const item: Record<string, unknown> = {
    file: new File(['orig'], 'f', {
      type: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/webm',
    }),
    previewUrl: 'blob:orig',
    kind,
    status: 'compressed',
    compressed: { blob: new Blob(['old']), width: 1, height: 1 },
    compressionPromise: Promise.resolve(),
    compressionError: null,
    editParams: null,
    editedPreviewUrl: null,
  };
  const pending = new Map([['x1', item]]);
  return { previewRoot, itemEl, item, pending };
}

describe('reprocessItem', () => {
  it('imagen: guarda editParams, transita a compressed y cambia el src del preview', async () => {
    const { previewRoot, itemEl, item, pending } = setup('image');
    const crop = { sx: 0, sy: 0, sw: 50, sh: 40 };
    await reprocessItem('x1', pending, previewRoot, { crop });
    await flush();
    expect(item.editParams).toEqual({ crop });
    expect(item.status).toBe('compressed');
    expect((item.compressed as { blob: Blob }).blob.type).toBe('image/webp');
    expect(item.editedPreviewUrl).toBeTruthy();
    expect(itemEl.querySelector('img')!.getAttribute('src')).toBe(item.editedPreviewUrl);
  });

  it('vídeo: regenera y deja thumbBlob en el resultado', async () => {
    const { previewRoot, item, pending } = setup('video');
    await reprocessItem('x1', pending, previewRoot, { trim: { start: 1, duration: 3 } });
    await flush();
    expect(item.status).toBe('compressed');
    expect((item.compressed as { thumbBlob: Blob }).thumbBlob).toBeTruthy();
    expect((item.compressed as { blob: Blob }).blob.type).toBe('video/webm');
  });

  it('audio con trim: usa trimAudio (mockeado) y queda compressed', async () => {
    const { previewRoot, item, pending } = setup('audio');
    await reprocessItem('x1', pending, previewRoot, { trim: { start: 0.5, duration: 2 } });
    await flush();
    expect(item.status).toBe('compressed');
    expect((item.compressed as { blob: Blob }).blob.type).toBe('audio/ogg');
  });

  it('item ya quitado del pending: no-op (devuelve null)', async () => {
    const { previewRoot, pending } = setup('image');
    pending.delete('x1');
    const r = await reprocessItem('x1', pending, previewRoot, { crop: { sx: 0, sy: 0, sw: 10, sh: 10 } });
    expect(r).toBeNull();
  });
});
