// @vitest-environment happy-dom
//
// Tests de regresión de escapado (anti-XSS). La auditoría confirmó que todo
// input de usuario va escapado antes de innerHTML; estos tests LO BLINDAN: si
// un cambio futuro mete un valor de usuario sin escapar, fallan aquí en vez de
// convertirse en un XSS en producción.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderPost } from '../public/js/render.js';

const PAYLOAD = '<img src=x onerror="alert(1)">';

function reset() {
  document.body.innerHTML = '';
  localStorage.clear();
}

function makePost(over = {}) {
  return {
    id: 1, text: '', parent_id: null, created_at: '2026-06-05T10:00:00.000Z',
    media: [], hashtags: [], reply_count: 0, poll: null, parent_excerpt: null, replies: [],
    ...over,
  };
}

describe('escapado anti-XSS', () => {
  beforeEach(reset);

  it('el texto del post no inyecta HTML vivo', () => {
    const el = renderPost(makePost({ text: PAYLOAD }), { topLevel: true });
    // el <img> malicioso NO debe existir como elemento real…
    expect(el.querySelector('.post-text img')).toBeNull();
    // …y el texto debe estar presente como texto plano (escapado).
    expect(el.querySelector('.post-text')!.textContent).toContain('onerror');
  });

  it('el label de una opción de encuesta no inyecta HTML', () => {
    const poll = {
      options: [{ id: 1, position: 0, label: PAYLOAD, votes: 0 }, { id: 2, position: 1, label: 'ok', votes: 0 }],
      total_votes: 0, my_vote_id: null,
    };
    const el = renderPost(makePost({ poll }), { topLevel: true });
    expect(el.querySelector('.poll img')).toBeNull();
    expect(el.querySelector('.poll-label')!.textContent).toContain('onerror');
  });

  it('el snippet del padre (reply-context) no inyecta HTML', () => {
    const el = renderPost(
      makePost({ id: 2, parent_id: 1, parent_excerpt: { id: 1, text_snippet: PAYLOAD, deleted: false } }),
      { topLevel: true },
    );
    expect(el.querySelector('.reply-context img')).toBeNull();
    expect(el.querySelector('.reply-context')!.textContent).toContain('onerror');
  });

  it('un hashtag en el texto se linkifica pero el resto queda escapado', () => {
    const el = renderPost(makePost({ text: `${PAYLOAD} #tag` }), { topLevel: true });
    // el #tag sí se vuelve <a class="hashtag"> (linkify legítimo)…
    expect(el.querySelector('.post-text a.hashtag')).toBeTruthy();
    // …pero el payload sigue sin inyectar un <img>.
    expect(el.querySelector('.post-text img')).toBeNull();
  });
});
