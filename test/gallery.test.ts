// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderPostGallery, swapStage, openLightbox, closeLightbox } from '../public/js/gallery.js';

function mount(html: string) {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe('renderPostGallery', () => {
  it('media vacío → string vacío', () => {
    expect(renderPostGallery([])).toBe('');
    expect(renderPostGallery(undefined as any)).toBe('');
  });

  it('1 imagen: stage con <img>, sin .thumbs', () => {
    const html = renderPostGallery([{ kind: 'image', r2_key: 'a.jpg' } as any]);
    const el = mount(html);
    expect(el.classList.contains('gallery')).toBe(true);
    expect(el.dataset.count).toBe('1');
    expect(el.querySelector(':scope > .stage > img')!.getAttribute('src')).toBe('/r2/a.jpg');
    expect(el.querySelector(':scope > .thumbs')).toBeNull();
  });

  it('1 vídeo: stage con <video controls> y sin autoplay', () => {
    const html = renderPostGallery([{ kind: 'video', r2_key: 'v.mp4', thumb_key: 't.jpg' } as any]);
    const el = mount(html);
    const vid = el.querySelector(':scope > .stage > video') as HTMLVideoElement;
    expect(vid).toBeTruthy();
    expect(vid.hasAttribute('controls')).toBe(true);
    expect(vid.hasAttribute('autoplay')).toBe(false);
    expect(vid.getAttribute('poster')).toBe('/r2/t.jpg');
  });

  it('N>1: aparecen .thumbs centradas y la primera con is-active', () => {
    const media = [
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
      { kind: 'video', r2_key: 'c.mp4', thumb_key: 'ct.jpg' },
    ] as any[];
    const el = mount(renderPostGallery(media));
    const thumbs = el.querySelectorAll(':scope > .thumbs > .thumb');
    expect(thumbs.length).toBe(3);
    expect(thumbs[0].classList.contains('is-active')).toBe(true);
    expect(thumbs[0].getAttribute('aria-selected')).toBe('true');
    expect(thumbs[1].classList.contains('is-active')).toBe(false);
    // thumb de vídeo: usa thumb_key + play-badge
    expect((thumbs[2].querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/r2/ct.jpg');
    expect(thumbs[2].querySelector('.play-badge')).toBeTruthy();
  });

  it('thumb de vídeo sin thumb_key cae en placeholder', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'video', r2_key: 'v.mp4', thumb_key: null },
    ] as any));
    const thumbVid = el.querySelectorAll(':scope > .thumbs > .thumb')[1];
    expect(thumbVid.querySelector('.thumb-placeholder')).toBeTruthy();
    expect(thumbVid.querySelector('img')).toBeNull();
  });

  it('data-media contiene la lista en JSON (legible por dataset)', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'video', r2_key: 'v.mp4', thumb_key: 't.jpg' },
    ] as any));
    const parsed = JSON.parse(el.dataset.media!);
    expect(parsed).toEqual([
      { k: 'image', r: 'a.jpg', t: null },
      { k: 'video', r: 'v.mp4', t: 't.jpg' },
    ]);
  });
});

describe('swapStage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('cambia el stage al índice pedido y mueve is-active', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any));
    swapStage(el, 1);
    const stage = el.querySelector(':scope > .stage') as HTMLElement;
    expect(stage.dataset.index).toBe('1');
    expect((stage.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/r2/b.jpg');
    const thumbs = el.querySelectorAll(':scope > .thumbs > .thumb');
    expect(thumbs[0].classList.contains('is-active')).toBe(false);
    expect(thumbs[1].classList.contains('is-active')).toBe(true);
    expect(thumbs[1].getAttribute('aria-selected')).toBe('true');
  });

  it('cambiar imagen → vídeo reemplaza la etiqueta sin tocar el wrapper', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'video', r2_key: 'v.mp4', thumb_key: 't.jpg' },
    ] as any));
    swapStage(el, 1);
    const stage = el.querySelector(':scope > .stage')!;
    expect(stage.querySelector('img')).toBeNull();
    const vid = stage.querySelector('video') as HTMLVideoElement;
    expect(vid).toBeTruthy();
    expect(vid.hasAttribute('controls')).toBe(true);
    expect(vid.hasAttribute('autoplay')).toBe(false);
  });

  it('índice fuera de rango → no toca el stage', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any));
    swapStage(el, 99);
    swapStage(el, -1);
    const stage = el.querySelector(':scope > .stage') as HTMLElement;
    expect(stage.dataset.index).toBe('0');
    expect((stage.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/r2/a.jpg');
  });
});

describe('lightbox', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    closeLightbox();
  });

  it('openLightbox con N>1 muestra contador y flechas', () => {
    openLightbox([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any, 0);
    const lb = document.querySelector('.lightbox') as HTMLElement;
    expect(lb.hidden).toBe(false);
    expect(document.body.classList.contains('lightbox-open')).toBe(true);
    expect(lb.querySelector('.lightbox-counter')!.textContent).toBe('1 / 2');
    expect((lb.querySelector('.lightbox-prev') as HTMLElement).hidden).toBe(false);
    expect((lb.querySelector('.lightbox-next') as HTMLElement).hidden).toBe(false);
  });

  it('openLightbox con 1 item oculta flechas y contador', () => {
    openLightbox([{ kind: 'image', r2_key: 'solo.jpg' }] as any, 0);
    const lb = document.querySelector('.lightbox') as HTMLElement;
    expect((lb.querySelector('.lightbox-prev') as HTMLElement).hidden).toBe(true);
    expect((lb.querySelector('.lightbox-next') as HTMLElement).hidden).toBe(true);
    expect(lb.querySelector('.lightbox-counter')!.textContent).toBe('');
  });

  it('closeLightbox vacía el stage y libera el body', () => {
    openLightbox([{ kind: 'image', r2_key: 'a.jpg' }] as any, 0);
    closeLightbox();
    const lb = document.querySelector('.lightbox') as HTMLElement;
    expect(lb.hidden).toBe(true);
    expect(lb.querySelector('.lightbox-stage')!.innerHTML).toBe('');
    expect(document.body.classList.contains('lightbox-open')).toBe(false);
  });
});
