// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTapToActivate } from '../public/js/render.js';

// setupTapToActivate registra un único listener global. Como cada test
// monta un setupTapToActivate distinto, fuerza un body limpio para evitar
// que el listener del test anterior siga vivo. happy-dom no reinicia el
// document entre tests por defecto.
function reset() {
  document.body.innerHTML = '';
}

describe('setupTapToActivate', () => {
  beforeEach(reset);

  it('click fuera de cualquier .post quita .active de todos', () => {
    document.body.innerHTML = `
      <article class="post clickable active" id="p1"></article>
      <article class="post clickable active" id="p2"></article>
      <div id="outside">fuera</div>
    `;
    setupTapToActivate();
    document.querySelector('#outside')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelectorAll('.post.active').length).toBe(0);
  });

  it('click en otro .post quita .active del que estaba activo', () => {
    document.body.innerHTML = `
      <article class="post clickable active" id="p1"></article>
      <article class="post clickable" id="p2"></article>
    `;
    setupTapToActivate();
    document.querySelector('#p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('#p1')!.classList.contains('active')).toBe(false);
  });

  it('click en .post-actions no quita .active (deja que el botón actúe)', () => {
    document.body.innerHTML = `
      <article class="post clickable active" id="p1">
        <div class="post-actions"><button class="reply-btn">responder</button></div>
      </article>
    `;
    setupTapToActivate();
    document.querySelector('.reply-btn')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(document.querySelector('#p1')!.classList.contains('active')).toBe(true);
  });

  it('click en el mismo .post.active no quita su propia clase', () => {
    document.body.innerHTML = `
      <article class="post clickable active" id="p1">
        <p class="post-text">hola</p>
      </article>
    `;
    setupTapToActivate();
    document.querySelector('.post-text')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    // El listener global excluye al post bajo el click, así que .active persiste.
    expect(document.querySelector('#p1')!.classList.contains('active')).toBe(true);
  });

  it('click en .post sin .clickable no toca a otros .active', () => {
    // En single-view el post principal no tiene .clickable. Aun así, click
    // dentro de él debería quitar .active de otros .post.clickable.
    document.body.innerHTML = `
      <article class="post active" id="single">contenido</article>
      <article class="post clickable active" id="other"></article>
    `;
    setupTapToActivate();
    document.querySelector('#single')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    // El #single no es .clickable: closest('.post.clickable') → null → quita
    // .active de todos los .clickable.
    expect(document.querySelector('#other')!.classList.contains('active')).toBe(false);
  });
});
