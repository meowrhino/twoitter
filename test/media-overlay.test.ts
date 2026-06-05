// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createPreviewItem, setItemStatus } from '../public/js/media.js';

function makeItem(kind: 'image' | 'video' | 'audio' = 'image') {
  return createPreviewItem({ localId: '1', previewUrl: 'blob:x', kind });
}

describe('createPreviewItem', () => {
  it('genera el item con status overlay oculto al inicio', () => {
    const el = makeItem();
    expect(el.className).toBe('item item-image');
    expect(el.dataset.localId).toBe('1');
    expect(el.querySelector('img')).toBeTruthy();
    expect(el.querySelector('.status')).toBeTruthy();
    expect(el.querySelector('.status-bar-fill')).toBeTruthy();
    expect(el.querySelector('.status-label')!.textContent).toBe('');
    expect(el.querySelector('.status')!.classList.contains('visible')).toBe(false);
  });

  it('usa <video> para kind=video', () => {
    const el = makeItem('video');
    expect(el.className).toBe('item item-video');
    expect(el.querySelector('video')).toBeTruthy();
    expect(el.querySelector('img')).toBeFalsy();
  });

  it('usa el audio-player completo del feed para kind=audio (para preview escuchable)', () => {
    const el = makeItem('audio');
    expect(el.className).toBe('item item-audio');
    // Antes era un icono + <audio> oculto. Cambió a audioPlayerMarkup para que
    // el usuario pueda escuchar la nota antes de publicar.
    expect(el.querySelector('.audio-player')).toBeTruthy();
    expect(el.querySelector('audio')).toBeTruthy();
    expect(el.querySelector('img')).toBeFalsy();
    expect(el.querySelector('video')).toBeFalsy();
  });

  it('tiene aria-live=polite en el overlay para lectores', () => {
    const el = makeItem();
    expect(el.querySelector('.status')!.getAttribute('aria-live')).toBe('polite');
  });

  it('imagen y vídeo llevan botón "recortar"', () => {
    expect(makeItem('image').querySelector('.edit')).toBeTruthy();
    expect(makeItem('video').querySelector('.edit')).toBeTruthy();
  });

  it('audio sin capacidades ffmpeg (happy-dom) NO lleva botón "recortar"', () => {
    // El trim de audio necesita ffmpeg/SharedArrayBuffer; en el entorno de test
    // no hay caps → canEditKind('audio') es false → no se pinta el botón.
    expect(makeItem('audio').querySelector('.edit')).toBeFalsy();
  });
});

describe('setItemStatus', () => {
  it('compressing con percent: actualiza barra y label', () => {
    const el = makeItem();
    setItemStatus(el, 'compressing', { percent: 42, label: 'comprimiendo' });
    const status = el.querySelector('.status')!;
    const fill = el.querySelector('.status-bar-fill') as HTMLElement;
    const label = el.querySelector('.status-label')!;
    expect(status.classList.contains('visible')).toBe(true);
    expect(status.classList.contains('indeterminate')).toBe(false);
    expect(fill.style.width).toBe('42%');
    expect(label.textContent).toBe('comprimiendo 42%');
  });

  it('compressing sin percent: modo indeterminate con label', () => {
    const el = makeItem();
    setItemStatus(el, 'compressing', { label: 'preparando vídeo…' });
    const status = el.querySelector('.status')!;
    const fill = el.querySelector('.status-bar-fill') as HTMLElement;
    expect(status.classList.contains('indeterminate')).toBe(true);
    expect(fill.style.width).toBe('');
    expect(el.querySelector('.status-label')!.textContent).toBe('preparando vídeo…');
  });

  it('compressing sin percent ni label: cae a "preparando…"', () => {
    const el = makeItem();
    setItemStatus(el, 'compressing', {});
    expect(el.querySelector('.status-label')!.textContent).toBe('preparando…');
  });

  it('compressed: barra al 100% con sizeMB', () => {
    const el = makeItem();
    setItemStatus(el, 'compressed', { sizeMB: '5.32' });
    const status = el.querySelector('.status')!;
    expect(status.classList.contains('status-ok')).toBe(true);
    expect(status.classList.contains('indeterminate')).toBe(false);
    expect((el.querySelector('.status-bar-fill') as HTMLElement).style.width).toBe('100%');
    expect(el.querySelector('.status-label')!.textContent).toBe('5.32 MB · listo');
  });

  it('uploading: indeterminate con "subiendo a R2…"', () => {
    const el = makeItem();
    setItemStatus(el, 'uploading');
    const status = el.querySelector('.status')!;
    expect(status.classList.contains('indeterminate')).toBe(true);
    expect(el.querySelector('.status-label')!.textContent).toBe('subiendo a R2…');
  });

  it('ok: status-ok + label "publicado", sin auto-hide', () => {
    const el = makeItem();
    setItemStatus(el, 'ok');
    const status = el.querySelector('.status')!;
    expect(status.classList.contains('status-ok')).toBe(true);
    expect(status.classList.contains('visible')).toBe(true);
    expect((el.querySelector('.status-bar-fill') as HTMLElement).style.width).toBe('100%');
    expect(el.querySelector('.status-label')!.textContent).toBe('publicado');
  });

  it('error con message: status-err + texto del mensaje', () => {
    const el = makeItem();
    setItemStatus(el, 'error', { message: 'fallo de red' });
    const status = el.querySelector('.status')!;
    expect(status.classList.contains('status-err')).toBe(true);
    expect(el.querySelector('.status-label')!.textContent).toBe('fallo de red');
  });

  it('error sin message: cae al texto "error"', () => {
    const el = makeItem();
    setItemStatus(el, 'error');
    expect(el.querySelector('.status-label')!.textContent).toBe('error');
  });

  it('clear: quita visible y todas las modifier classes', () => {
    const el = makeItem();
    setItemStatus(el, 'compressed', { sizeMB: '1.5' });
    setItemStatus(el, 'clear');
    const status = el.querySelector('.status')!;
    expect(status.classList.contains('visible')).toBe(false);
    expect(status.classList.contains('status-ok')).toBe(false);
    expect(status.classList.contains('indeterminate')).toBe(false);
  });

  it('transición compressing → compressed quita indeterminate', () => {
    const el = makeItem();
    setItemStatus(el, 'compressing', { label: 'preparando…' });
    expect(el.querySelector('.status')!.classList.contains('indeterminate')).toBe(true);
    setItemStatus(el, 'compressed', { sizeMB: '2.1' });
    expect(el.querySelector('.status')!.classList.contains('indeterminate')).toBe(false);
  });
});
