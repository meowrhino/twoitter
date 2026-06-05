// @vitest-environment happy-dom
//
// Tests del flujo CON RED de la timeline (pages.js): loadTimeline pagina,
// pinta por chunks y auto-carga al llegar al fondo (IntersectionObserver).
// Es el otro flujo cliente que más cambió y que no estaba cubierto. Mockeamos
// `fetch` (api.js lo usa) y stubbeamos IntersectionObserver para disparar el
// auto-fetch de forma determinista.
//
// Nota: pages.js tiene estado de módulo (nextCursor, loading, sentinelObserver,
// firstPaintDone) que persiste entre tests. Por eso cada test es autocontenido
// (hace su propia carga inicial) en lugar de asumir un estado limpio.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadTimeline } from '../public/js/pages.js';
import { MemStorage } from './helpers/mem-storage';

// happy-dom v20 no expone localStorage como global (ver test/helpers/mem-storage.ts).
vi.stubGlobal('localStorage', new MemStorage());

// ---- fetch mock que registra las URLs y responde según un responder ----
let fetchCalls: Array<{ url: string; opts: RequestInit | undefined }> = [];
function installFetch(
  responder: (url: string) => unknown,
  { ok = true, status = 200 } = {},
) {
  const fn = vi.fn(async (url: string, opts?: RequestInit) => {
    fetchCalls.push({ url, opts });
    return { ok, status, json: async () => responder(url) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ---- IntersectionObserver fake: captura el callback para dispararlo a mano ----
let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
class FakeIO {
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    ioCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

// post mínimo con la forma que renderThread espera.
function makePost(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    text: 'hola',
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

function mountTimeline() {
  document.body.innerHTML = `<div id="timeline"></div><button id="loadMore" hidden></button>`;
}

beforeEach(() => {
  fetchCalls = [];
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', FakeIO);
  mountTimeline();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadTimeline — carga + paginación', () => {
  it('reset: pinta los posts del server y muestra #loadMore si hay nextCursor', async () => {
    installFetch(() => ({ posts: [makePost({ id: 1 }), makePost({ id: 2 })], nextCursor: 'cur1' }));

    await loadTimeline(true);

    // el render es por chunks (requestAnimationFrame) → esperar a que asiente.
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#timeline .thread')).toHaveLength(2),
    );
    expect(document.querySelectorAll('#timeline article.post[data-id="1"]')).toHaveLength(1);
    expect((document.getElementById('loadMore') as HTMLButtonElement).hidden).toBe(false);
    // la primera petición no lleva cursor (es la página inicial).
    expect(fetchCalls[0].url).not.toContain('cursor=');
  });

  it('reset sin nextCursor: #loadMore queda oculto', async () => {
    installFetch(() => ({ posts: [makePost({ id: 5 })], nextCursor: null }));

    await loadTimeline(true);

    await vi.waitFor(() =>
      expect(document.querySelectorAll('#timeline .thread')).toHaveLength(1),
    );
    expect((document.getElementById('loadMore') as HTMLButtonElement).hidden).toBe(true);
  });

  it('reset limpia los skeletons previos del #timeline antes de pintar', async () => {
    const tl = document.getElementById('timeline') as HTMLDivElement;
    tl.innerHTML = '<div class="sk">skeleton viejo</div>';
    installFetch(() => ({ posts: [makePost({ id: 9 })], nextCursor: null }));

    await loadTimeline(true);

    await vi.waitFor(() =>
      expect(document.querySelectorAll('#timeline .thread')).toHaveLength(1),
    );
    expect(tl.querySelector('.sk')).toBeNull();
  });

  it('loadMore (reset:false) tras una primera carga: la segunda petición lleva el cursor', async () => {
    // página 1 → nextCursor 'curA'; página 2 (con cursor) → fin.
    installFetch((url) =>
      url.includes('cursor=')
        ? { posts: [makePost({ id: 20 })], nextCursor: null }
        : { posts: [makePost({ id: 10 })], nextCursor: 'curA' },
    );

    await loadTimeline(true);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#timeline .thread')).toHaveLength(1),
    );

    await loadTimeline(false);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#timeline .thread')).toHaveLength(2),
    );
    const second = fetchCalls[fetchCalls.length - 1].url;
    expect(second).toContain('cursor=curA');
    // los nuevos posts se APPENDEAN (no reemplazan): el #10 sigue ahí.
    expect(document.querySelector('#timeline article.post[data-id="10"]')).toBeTruthy();
    expect(document.querySelector('#timeline article.post[data-id="20"]')).toBeTruthy();
  });
});

describe('loadTimeline — robustez', () => {
  it('respuesta de error (5xx): no rompe, limpia el feed y avisa con un toast', async () => {
    installFetch(() => ({ error: 'internal' }), { ok: false, status: 500 });

    await expect(loadTimeline(true)).resolves.toBeUndefined(); // no lanza
    expect(document.querySelectorAll('#timeline .thread')).toHaveLength(0);
    expect(document.querySelector('.toast-error')).toBeTruthy();
  });

  it('respuesta sin array posts: tratada como "sin más", feed vacío sin romper', async () => {
    installFetch(() => ({ nextCursor: null })); // no trae `posts`

    await loadTimeline(true);
    expect(document.querySelectorAll('#timeline .thread')).toHaveLength(0);
    expect((document.getElementById('loadMore') as HTMLButtonElement).hidden).toBe(true);
  });
});

describe('auto-fetch por IntersectionObserver', () => {
  it('cuando el sentinel intersecta y hay nextCursor, carga la página siguiente con su cursor', async () => {
    installFetch((url) =>
      url.includes('cursor=')
        ? { posts: [makePost({ id: 200 })], nextCursor: null }
        : { posts: [makePost({ id: 100 })], nextCursor: 'curX' },
    );

    await loadTimeline(true);
    await vi.waitFor(() =>
      expect(document.querySelector('#timeline article.post[data-id="100"]')).toBeTruthy(),
    );
    expect(ioCallback).toBeTypeOf('function');

    // simular que el sentinel entró en viewport.
    ioCallback!([{ isIntersecting: true }]);

    await vi.waitFor(() =>
      expect(document.querySelector('#timeline article.post[data-id="200"]')).toBeTruthy(),
    );
    expect(fetchCalls[fetchCalls.length - 1].url).toContain('cursor=curX');
  });

  it('si el sentinel NO intersecta, no dispara carga extra', async () => {
    installFetch((url) =>
      url.includes('cursor=')
        ? { posts: [makePost({ id: 201 })], nextCursor: null }
        : { posts: [makePost({ id: 101 })], nextCursor: 'curY' },
    );

    await loadTimeline(true);
    await vi.waitFor(() =>
      expect(document.querySelector('#timeline article.post[data-id="101"]')).toBeTruthy(),
    );
    const callsBefore = fetchCalls.length;

    ioCallback!([{ isIntersecting: false }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls.length).toBe(callsBefore); // no hubo fetch nuevo
  });
});
