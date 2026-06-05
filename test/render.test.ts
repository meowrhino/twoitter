// @vitest-environment happy-dom
//
// Tests del render del carrete (lo que más cambió esta sesión): la cabecera
// "↓ en respuesta a", el colapso del subárbol con su toggle, la distinción
// root (botón .resp-toggle) vs reply anidada (enlace .resp-count), el contador
// dinámico (updateReplyCount) y el render de encuestas.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderPost, renderThread, focusPostFromHash } from '../public/js/render.js';
import { updateReplyCount } from '../public/js/rails.js';
import { hide, clearHidden } from '../public/js/hidden.js';
import { MemStorage } from './helpers/mem-storage';

// happy-dom v20 no expone localStorage como global (ver test/helpers/mem-storage.ts).
vi.stubGlobal('localStorage', new MemStorage());

function reset() {
  document.body.innerHTML = '';
  localStorage.clear();
  clearHidden(); // invalida el cache de módulo de hidden.js (localStorage.clear no basta)
}

function makePost(over = {}) {
  return {
    id: 1,
    text: 'hola mundo',
    parent_id: null,
    created_at: '2026-06-05T10:00:00.000Z',
    media: [],
    hashtags: [],
    reply_count: 0,
    poll: null,
    parent_excerpt: null,
    replies: [],
    ...over,
  };
}

describe('reply-context ("↓ en respuesta a")', () => {
  beforeEach(reset);

  it('aparece en una reply top-level con snippet + link al padre', () => {
    const el = renderPost(
      makePost({ id: 2, parent_id: 1, parent_excerpt: { id: 1, text_snippet: 'el padre', deleted: false } }),
      { topLevel: true },
    );
    const ctx = el.querySelector('.reply-context') as HTMLAnchorElement;
    expect(ctx).toBeTruthy();
    expect(ctx.getAttribute('href')).toBe('#1');
    expect(ctx.textContent).toContain('el padre');
  });

  it('NO aparece cuando el post se renderiza anidado (topLevel:false)', () => {
    const el = renderPost(
      makePost({ id: 2, parent_id: 1, parent_excerpt: { id: 1, text_snippet: 'el padre', deleted: false } }),
      { topLevel: false },
    );
    expect(el.querySelector('.reply-context')).toBeNull();
  });

  it('padre borrado → texto sin link', () => {
    const el = renderPost(
      makePost({ id: 2, parent_id: 1, parent_excerpt: { id: 1, text_snippet: '', deleted: true } }),
      { topLevel: true },
    );
    const ctx = el.querySelector('.reply-context')!;
    expect(ctx.tagName).toBe('SPAN'); // no es <a>
    expect(ctx.textContent).toContain('borrado');
  });

  it('un root normal no lleva reply-context', () => {
    const el = renderPost(makePost(), { topLevel: true });
    expect(el.querySelector('.reply-context')).toBeNull();
  });
});

describe('colapso del subárbol + toggle', () => {
  beforeEach(reset);

  it('root con replies: subárbol colapsado + foot con .resp-toggle (no enlace)', () => {
    const root = makePost({ reply_count: 1, replies: [makePost({ id: 2, parent_id: 1, text: 'una reply' })] });
    const el = renderThread(root);
    const nested = el.querySelector(':scope > .thread-replies')!;
    expect(nested.classList.contains('replies-collapsed')).toBe(true);
    const foot = el.querySelector(':scope > .post-body > .post-foot')!;
    expect(foot.querySelector('.resp-toggle')).toBeTruthy();
    expect(foot.querySelector('a.resp-count')).toBeNull();
    expect(foot.querySelector('.resp-toggle')!.textContent!.trim()).toBe('1 respuesta');
  });

  it('click en el toggle expande (quita .replies-collapsed, aria true)', () => {
    const root = makePost({ reply_count: 2, replies: [makePost({ id: 2, parent_id: 1 })] });
    const el = renderThread(root);
    document.body.appendChild(el);
    const nested = el.querySelector(':scope > .thread-replies')!;
    const toggle = el.querySelector('.resp-toggle') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(nested.classList.contains('replies-collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('root sin replies: ni toggle ni contador', () => {
    const el = renderThread(makePost());
    const foot = el.querySelector(':scope > .post-body > .post-foot')!;
    expect(foot.querySelector('.resp-toggle')).toBeNull();
    expect(foot.querySelector('.resp-count')).toBeNull();
  });

  it('acordeón: una reply anidada con sus propias replies usa toggle + subárbol colapsado', () => {
    const grandchild = makePost({ id: 3, parent_id: 2 });
    const child = makePost({ id: 2, parent_id: 1, reply_count: 1, replies: [grandchild] });
    const root = makePost({ reply_count: 1, replies: [child] });
    const el = renderThread(root);
    const childEl = el.querySelector('article.post[data-id="2"]')!;
    const childFoot = childEl.querySelector(':scope > .post-body > .post-foot')!;
    // acordeón: cada nivel pliega y usa toggle (antes los anidados usaban .resp-count)
    expect(childFoot.querySelector('.resp-toggle')).toBeTruthy();
    expect(childFoot.querySelector('a.resp-count')).toBeNull();
    const childNested = childEl.querySelector(':scope > .thread-replies')!;
    expect(childNested.classList.contains('replies-collapsed')).toBe(true);
  });

  it('acordeón multinivel: cada nivel con replies nace plegado con su toggle; la hoja no', () => {
    // thread de 3 niveles: 1 → 2 → 3. (Como #88→#89→#90 del feed real.)
    const lvl3 = makePost({ id: 3, parent_id: 2 });
    const lvl2 = makePost({ id: 2, parent_id: 1, reply_count: 1, replies: [lvl3] });
    const root = makePost({ id: 1, reply_count: 1, replies: [lvl2] });
    const el = renderThread(root);

    const togOf = (id: number) =>
      el.querySelector(`article.post[data-id="${id}"] > .post-body > .post-foot > .resp-toggle`);
    const nestedOf = (id: number) =>
      el.querySelector(`article.post[data-id="${id}"] > .thread-replies`);

    // niveles 1 y 2: toggle "1 respuesta" + subárbol colapsado
    expect(togOf(1)).toBeTruthy();
    expect(nestedOf(1)!.classList.contains('replies-collapsed')).toBe(true);
    expect(togOf(2)).toBeTruthy();
    expect(nestedOf(2)!.classList.contains('replies-collapsed')).toBe(true);
    // nivel 3 (hoja): ni toggle ni subárbol
    expect(togOf(3)).toBeNull();
    expect(nestedOf(3)).toBeNull();
  });
});

describe('updateReplyCount (contador dinámico)', () => {
  beforeEach(reset);

  it('en un root: actualiza el .resp-toggle sin crear enlace duplicado', () => {
    const root = makePost({ reply_count: 1, replies: [makePost({ id: 2, parent_id: 1 })] });
    const wrap = document.createElement('div');
    wrap.className = 'thread';
    wrap.appendChild(renderThread(root));
    document.body.appendChild(wrap);
    const rootEl = wrap.querySelector('article.post[data-id="1"]') as HTMLElement;

    updateReplyCount(rootEl, +1);

    const foot = rootEl.querySelector(':scope > .post-body > .post-foot')!;
    expect(foot.querySelectorAll('.resp-toggle')).toHaveLength(1);
    expect(foot.querySelectorAll('a.resp-count')).toHaveLength(0); // sin duplicado
    expect(foot.querySelector('.resp-toggle')!.textContent!.trim()).toBe('2 respuestas');
  });

  it('al llegar a 0, elimina el toggle', () => {
    const root = makePost({ reply_count: 1, replies: [makePost({ id: 2, parent_id: 1 })] });
    const wrap = document.createElement('div');
    wrap.className = 'thread';
    wrap.appendChild(renderThread(root));
    const rootEl = wrap.querySelector('article.post[data-id="1"]') as HTMLElement;
    updateReplyCount(rootEl, -1);
    expect(rootEl.querySelector('.resp-toggle')).toBeNull();
  });

  it('acordeón: responder a una reply ANIDADA le materializa un toggle (no un enlace)', () => {
    // root (1) → child (2) sin replies aún. Llega una reply al child en vivo:
    // su contador debe aparecer como toggle plegable, no como enlace .resp-count.
    const root = makePost({ id: 1, reply_count: 1, replies: [makePost({ id: 2, parent_id: 1 })] });
    const wrap = document.createElement('div');
    wrap.className = 'thread';
    wrap.appendChild(renderThread(root));
    document.body.appendChild(wrap);
    const childEl = wrap.querySelector('article.post[data-id="2"]') as HTMLElement;
    // simular la inserción de la respuesta nueva bajo el child (como hace el composer)
    const nested = document.createElement('div');
    nested.className = 'thread-replies';
    nested.appendChild(renderThread(makePost({ id: 3, parent_id: 2 }), { asRoot: false }));
    childEl.querySelector(':scope > .post-body')!.after(nested);
    updateReplyCount(childEl, +1);
    const foot = childEl.querySelector(':scope > .post-body > .post-foot')!;
    expect(foot.querySelector('.resp-toggle')).toBeTruthy();
    expect(foot.querySelector('a.resp-count')).toBeNull();
    expect(foot.querySelector('.resp-toggle')!.textContent!.trim()).toBe('1 respuesta');
  });
});

describe('posts ocultos', () => {
  beforeEach(reset);

  it('un post oculto se renderiza como stub revelable, no se omite', () => {
    hide(7);
    const el = renderPost(makePost({ id: 7 }), { topLevel: true });
    expect(el.classList.contains('post-hidden')).toBe(true);
    const stub = el.querySelector(':scope > .hidden-stub')!;
    expect(stub).toBeTruthy();
    expect(stub.textContent).toContain('oculto');
  });

  it('renderThread ya NO devuelve null para un post oculto', () => {
    hide(7);
    const el = renderThread(makePost({ id: 7 }));
    expect(el).not.toBeNull();
    expect(el!.classList.contains('post-hidden')).toBe(true);
  });

  it('un post no oculto se renderiza normal (sin stub)', () => {
    const el = renderPost(makePost({ id: 7 }), { topLevel: true });
    expect(el.classList.contains('post-hidden')).toBe(false);
    expect(el.querySelector('.hidden-stub')).toBeNull();
  });
});

describe('focusPostFromHash (deep-link)', () => {
  beforeEach(reset);

  it('al llegar por hash a un post OCULTO, la barra ofrece "desocultar" (refresca el botón como la ruta de click)', () => {
    // Regresión #1: focusPostFromHash debe refrescar el botón ocultar/desocultar
    // igual que bindPostClickToNavigate. Sin refreshThreadHideBtn, un post
    // alcanzado por /#id mostraba "ocultar" estando ya oculto.
    hide(42);
    const wrap = document.createElement('div');
    wrap.className = 'thread';
    wrap.appendChild(renderThread(makePost({ id: 42 })));
    document.body.appendChild(wrap);
    const rootEl = wrap.querySelector('article.post[data-id="42"]') as HTMLElement;

    location.hash = '#42';
    focusPostFromHash('instant');

    const bar = rootEl.querySelector(':scope > .post-actions')!;
    const hideBtn = bar.querySelector('.hide-btn') as HTMLButtonElement;
    const unhideBtn = bar.querySelector('.unhide-btn') as HTMLButtonElement;
    expect(unhideBtn.hidden).toBe(false); // se ofrece "desocultar"
    expect(hideBtn.hidden).toBe(true);    // y no "ocultar"
  });
});

describe('render de encuesta', () => {
  beforeEach(reset);

  it('pinta opciones con % y total', () => {
    const poll = {
      options: [
        { id: 1, position: 0, label: 'sí', votes: 3 },
        { id: 2, position: 1, label: 'no', votes: 1 },
      ],
      total_votes: 4,
      my_vote_id: null,
    };
    const el = renderPost(makePost({ poll }), { topLevel: true });
    const block = el.querySelector('.poll')!;
    expect(block).toBeTruthy();
    const labels = [...block.querySelectorAll('.poll-label')].map((l) => l.textContent);
    expect(labels).toEqual(['sí', 'no']);
    const pcts = [...block.querySelectorAll('.poll-pct')].map((p) => p.textContent);
    expect(pcts).toEqual(['75%', '25%']);
  });

  it('si ya votaste, las opciones son estáticas (no botones)', () => {
    const poll = {
      options: [{ id: 1, position: 0, label: 'sí', votes: 1 }, { id: 2, position: 1, label: 'no', votes: 0 }],
      total_votes: 1,
      my_vote_id: 1,
    };
    const el = renderPost(makePost({ poll }), { topLevel: true });
    const opts = el.querySelectorAll('.poll-option');
    expect([...opts].every((o) => o.tagName === 'DIV')).toBe(true);
    expect(el.querySelector('.poll-option-mine')).toBeTruthy();
  });
});
