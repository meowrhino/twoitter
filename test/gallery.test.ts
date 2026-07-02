// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderPostGallery, swapStage, updateGalleryTranscript } from '../public/js/gallery.js';
import { openLightbox, closeLightbox } from '../public/js/lightbox.js';

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
      { k: 'image', r: 'a.jpg', t: null, id: null, tr: null, tr_at: null, to: null, te: null },
      { k: 'video', r: 'v.mp4', t: 't.jpg', id: null, tr: null, tr_at: null, to: null, te: null },
    ]);
  });

  it('audio: stage con .audio-player (custom) y sin autoplay, thumb con glyph', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm' },
      { kind: 'image', r2_key: 'a.jpg' },
    ] as any));
    const player = el.querySelector(':scope > .stage > .audio-player');
    expect(player).toBeTruthy();
    expect(player!.querySelector('.ap-play')).toBeTruthy();
    expect(player!.querySelector('.ap-progress')).toBeTruthy();
    expect(player!.querySelector('.ap-time')).toBeTruthy();
    const audio = player!.querySelector('audio') as HTMLAudioElement;
    expect(audio).toBeTruthy();
    // El <audio> nativo no debe llevar controls (los pinta el player custom)
    // ni autoplay (regla del proyecto: nunca autoplay).
    expect(audio.hasAttribute('controls')).toBe(false);
    expect(audio.hasAttribute('autoplay')).toBe(false);
    expect(audio.getAttribute('src')).toBe('/r2/n.webm');
    const thumbs = el.querySelectorAll(':scope > .thumbs > .thumb');
    expect(thumbs[0].classList.contains('thumb-audio')).toBe(true);
    expect(thumbs[0].querySelector('.audio-glyph')).toBeTruthy();
  });

  it('audio con transcript previo: lo pinta visible bajo el <audio>', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm', transcript: 'hola mundo' },
    ] as any));
    const stage = el.querySelector(':scope > .stage')!;
    const tr = stage.querySelector('.audio-transcript') as HTMLElement;
    expect(tr).toBeTruthy();
    expect(tr.hidden).toBe(false);
    expect(tr.textContent).toBe('hola mundo');
  });

  it('audio sin transcript: el bloque existe pero está oculto', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm' },
    ] as any));
    const tr = el.querySelector('.audio-transcript') as HTMLElement;
    expect(tr).toBeTruthy();
    expect(tr.hidden).toBe(true);
  });

  it('updateGalleryTranscript(mediaId) rellena texto + hora del audio activo y su data-media', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'n.webm', id: 7 },
    ] as any));
    updateGalleryTranscript(el, 7, 'transcripción nueva', '2026-06-19T19:05:00.000Z');
    const tr = el.querySelector('.audio-transcript') as HTMLElement;
    expect(tr.hidden).toBe(false);
    expect(tr.querySelector('.transcript-text')!.textContent).toBe('transcripción nueva');
    // "transcrito el 19 de junio de 2026 a las HH:MM" (fecha entera; TZ del runner aparte).
    expect(tr.querySelector('.transcript-time')!.textContent).toMatch(/^transcrito el \d{1,2} de \w+ de \d{4} a las \d{2}:\d{2}$/);
    const parsed = JSON.parse(el.dataset.media!);
    expect(parsed[0].tr).toBe('transcripción nueva');
    expect(parsed[0].tr_at).toBe('2026-06-19T19:05:00.000Z');
  });

  it('updateGalleryTranscript sólo toca el audio con ese id (no pisa a los demás)', () => {
    const el = mount(renderPostGallery([
      { kind: 'audio', r2_key: 'a.webm', id: 1 },
      { kind: 'audio', r2_key: 'b.webm', id: 2 },
    ] as any));
    updateGalleryTranscript(el, 2, 'sólo el segundo', '2026-06-19T19:05:00.000Z');
    const parsed = JSON.parse(el.dataset.media!);
    expect(parsed[0].tr).toBe(null); // audio 1 intacto
    expect(parsed[1].tr).toBe('sólo el segundo');
    expect(parsed[1].tr_at).toBe('2026-06-19T19:05:00.000Z');
  });
});

describe('swapStage', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('cambia el stage al índice pedido y mueve is-active', async () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any));
    await swapStage(el, 1);
    const stage = el.querySelector(':scope > .stage') as HTMLElement;
    expect(stage.dataset.index).toBe('1');
    expect((stage.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/r2/b.jpg');
    const thumbs = el.querySelectorAll(':scope > .thumbs > .thumb');
    expect(thumbs[0].classList.contains('is-active')).toBe(false);
    expect(thumbs[1].classList.contains('is-active')).toBe(true);
    expect(thumbs[1].getAttribute('aria-selected')).toBe('true');
  });

  it('thumb feedback (is-active) es inmediato, sin esperar al fade', () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any));
    // fire-and-forget; antes del await, el thumb activo ya debe haber cambiado.
    void swapStage(el, 1);
    const thumbs = el.querySelectorAll(':scope > .thumbs > .thumb');
    expect(thumbs[1].classList.contains('is-active')).toBe(true);
    expect(thumbs[0].classList.contains('is-active')).toBe(false);
  });

  it('cambiar imagen → vídeo reemplaza la etiqueta sin tocar el wrapper', async () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'video', r2_key: 'v.mp4', thumb_key: 't.jpg' },
    ] as any));
    await swapStage(el, 1);
    const stage = el.querySelector(':scope > .stage')!;
    expect(stage.querySelector('img')).toBeNull();
    const vid = stage.querySelector('video') as HTMLVideoElement;
    expect(vid).toBeTruthy();
    expect(vid.hasAttribute('controls')).toBe(true);
    expect(vid.hasAttribute('autoplay')).toBe(false);
  });

  it('índice fuera de rango → no toca el stage', async () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
    ] as any));
    await swapStage(el, 99);
    await swapStage(el, -1);
    const stage = el.querySelector(':scope > .stage') as HTMLElement;
    expect(stage.dataset.index).toBe('0');
    expect((stage.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('/r2/a.jpg');
  });

  it('clicks rápidos: sólo el último gana (race-guard)', async () => {
    const el = mount(renderPostGallery([
      { kind: 'image', r2_key: 'a.jpg' },
      { kind: 'image', r2_key: 'b.jpg' },
      { kind: 'image', r2_key: 'c.jpg' },
    ] as any));
    // tres swaps en seguida, sólo esperamos a que termine el último.
    void swapStage(el, 1);
    void swapStage(el, 2);
    const last = swapStage(el, 0);
    await last;
    // pequeño respiro para que los otros (en vuelo) intenten pintar y aborten.
    await new Promise((r) => setTimeout(r, 50));
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

  it('openLightbox con N>1 muestra contador y flechas (sincrónicamente)', () => {
    // contador/flechas se setean sincrónicamente; no hace falta await.
    void openLightbox([
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
    void openLightbox([{ kind: 'image', r2_key: 'solo.jpg' }] as any, 0);
    const lb = document.querySelector('.lightbox') as HTMLElement;
    expect((lb.querySelector('.lightbox-prev') as HTMLElement).hidden).toBe(true);
    expect((lb.querySelector('.lightbox-next') as HTMLElement).hidden).toBe(true);
    expect(lb.querySelector('.lightbox-counter')!.textContent).toBe('');
  });

  it('openLightbox pinta el media tras el preload', async () => {
    await openLightbox([{ kind: 'image', r2_key: 'a.jpg' }] as any, 0);
    const stage = document.querySelector('.lightbox-stage') as HTMLElement;
    const img = stage.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/r2/a.jpg');
  });

  it('closeLightbox cancela cualquier render en vuelo y vacía el stage', async () => {
    // fire-and-forget el open; cerrar antes de que el preload resuelva.
    void openLightbox([{ kind: 'image', r2_key: 'a.jpg' }] as any, 0);
    closeLightbox();
    // dejar que el openLightbox en vuelo termine (debería abortar por el ++lbNav)
    await new Promise((r) => setTimeout(r, 30));
    const lb = document.querySelector('.lightbox') as HTMLElement;
    expect(lb.hidden).toBe(true);
    expect(lb.querySelector('.lightbox-stage')!.innerHTML).toBe('');
    expect(document.body.classList.contains('lightbox-open')).toBe(false);
  });
});
