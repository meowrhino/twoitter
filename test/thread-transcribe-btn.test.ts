// @vitest-environment happy-dom
// "transcribir" vive en la barra del thread y actúa sobre el audio ACTIVO de la
// galería del post. refreshThreadTranscribeBtn decide si se ve: sólo cuando ese
// audio existe y aún no está transcrito. (El click → /api/media/:id/transcribe
// se prueba e2e en el navegador; aquí cubrimos la lógica de visibilidad.)
import { describe, it, expect, vi } from 'vitest';

// Con sesión: la barra debe incluir "transcribir" (igual gating que responder/borrar).
vi.mock('../public/js/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public/js/auth.js')>();
  return { ...actual, isAuthed: () => true };
});

import { renderPostGallery } from '../public/js/gallery.js';
import { refreshThreadTranscribeBtn, renderThreadActionsHtml } from '../public/js/post-actions.js';

function buildPost(media: any[]) {
  document.body.innerHTML = `
    <article class="post active clickable" data-id="1">
      <div class="post-body">
        <div class="post-text">x</div>
        ${renderPostGallery(media)}
      </div>
      <div class="post-actions">
        <button class="transcribe-btn" type="button" hidden>transcribir</button>
      </div>
    </article>`;
  return document.body.querySelector('.post') as HTMLElement;
}
const btnHidden = (post: HTMLElement) =>
  (post.querySelector('.transcribe-btn') as HTMLButtonElement).hidden;

describe('refreshThreadTranscribeBtn — visibilidad según el audio activo', () => {
  it('audio activo SIN transcript → botón visible', () => {
    const post = buildPost([{ kind: 'audio', r2_key: 'a.webm', id: 5 }]);
    refreshThreadTranscribeBtn(post);
    expect(btnHidden(post)).toBe(false);
  });

  it('audio activo YA transcrito → botón oculto', () => {
    const post = buildPost([{ kind: 'audio', r2_key: 'a.webm', id: 5, transcript: 'hola' }]);
    refreshThreadTranscribeBtn(post);
    expect(btnHidden(post)).toBe(true);
  });

  it('medio activo no-audio (imagen) → botón oculto', () => {
    const post = buildPost([{ kind: 'image', r2_key: 'a.jpg', id: 5 }]);
    refreshThreadTranscribeBtn(post);
    expect(btnHidden(post)).toBe(true);
  });

  it('post sin galería → botón oculto (no peta)', () => {
    document.body.innerHTML = `
      <article class="post active clickable" data-id="1">
        <div class="post-body"><div class="post-text">solo texto</div></div>
        <div class="post-actions"><button class="transcribe-btn" hidden>transcribir</button></div>
      </article>`;
    const post = document.body.querySelector('.post') as HTMLElement;
    refreshThreadTranscribeBtn(post);
    expect(btnHidden(post)).toBe(true);
  });

  it('con sesión, renderThreadActionsHtml mete "transcribir" en la barra (oculto por defecto)', () => {
    document.body.innerHTML = renderThreadActionsHtml();
    const btn = document.body.querySelector('.post-actions > .transcribe-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.hidden).toBe(true); // refreshThreadTranscribeBtn lo muestra cuando toca
  });
});
