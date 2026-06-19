// @vitest-environment happy-dom
// El botón "transcribir" por-audio (stageItemHtml en gallery.js) sólo se pinta
// con sesión iniciada (isAuthed()), estado que el resto de tests deja en false.
// Aquí mockeamos auth.js a authed=true — scope de fichero — para cubrir ese
// camino: cuándo aparece el botón, con qué media id, y cuándo NO debe aparecer.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../public/js/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public/js/auth.js')>();
  return { ...actual, isAuthed: () => true };
});

import { renderPostGallery } from '../public/js/gallery.js';

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('botón transcribir por-audio (authed)', () => {
  it('audio sin transcript → botón con su media id', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm', id: 42 },
    ] as any));
    const btn = el.querySelector('.stage > .audio-transcribe-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.dataset.mid).toBe('42');
  });

  it('audio YA transcrito → sin botón (sólo el texto)', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm', id: 42, transcript: 'hola' },
    ] as any));
    expect(el.querySelector('.audio-transcribe-btn')).toBeNull();
  });

  it('imagen/vídeo → nunca botón de transcribir', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg', id: 1 },
      { kind: 'video', r2_key: 'v.mp4', thumb_key: 't.jpg', id: 2 },
    ] as any));
    expect(el.querySelector('.audio-transcribe-btn')).toBeNull();
  });

  it('multi-audio: al pasar al 2º audio, su stage trae el botón con el id correcto', async () => {
    const { swapStage } = await import('../public/js/gallery.js');
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'a.webm', id: 10 },
      { kind: 'audio', r2_key: 'b.webm', id: 11 },
    ] as any));
    // stage inicial = audio 10
    expect((el.querySelector('.stage > .audio-transcribe-btn') as HTMLButtonElement).dataset.mid).toBe('10');
    await swapStage(el, 1);
    expect((el.querySelector('.stage > .audio-transcribe-btn') as HTMLButtonElement).dataset.mid).toBe('11');
  });
});
