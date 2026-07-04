// @vitest-environment happy-dom
//
// Tests del flujo CON RED del composer (wireComposer): publicar un post.
// Es uno de los dos flujos cliente que más cambiaron y que los tests de
// render/endpoints no tocaban. Mockeamos `fetch` global (api.js lo usa por
// debajo) con respuestas canned y verificamos el contrato del submit:
//   - qué se manda a /api/posts (url, método, CSRF, body)
//   - que onPosted recibe el post del server
//   - el feedback del botón ("publicando…" + disabled)
//   - el reset de los campos al publicar
//   - el comportamiento ante error de red (no limpia, no llama onPosted)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { wireComposer } from '../public/js/composer.js';
import { outboxCount } from '../public/js/outbox.js';

// fetch mock: api.js hace `await fetch(...)` y luego `res.json()`. Replicamos
// la forma mínima de Response que api.js consume (ok, status, json()).
function mockFetch(data: unknown, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({ ok, status, json: async () => data }));
}

// Monta el HTML mínimo que wireComposer necesita (textarea, preview, file
// input y botón submit) y devuelve los nodos ya resueltos.
function setupForm() {
  document.body.innerHTML = `
    <form id="composer">
      <textarea id="text"></textarea>
      <div id="mediaPreview"></div>
      <input type="file" id="fileInput" />
      <input type="text" id="locInput" class="loc-input" />
      <button type="button" class="geo-btn">ubicación</button>
      <button type="submit">publicar</button>
    </form>
  `;
  return {
    form: document.getElementById('composer') as HTMLFormElement,
    text: document.getElementById('text') as HTMLTextAreaElement,
    preview: document.getElementById('mediaPreview') as HTMLDivElement,
    fileInput: document.getElementById('fileInput') as HTMLInputElement,
    locInput: document.getElementById('locInput') as HTMLInputElement,
    submit: document.querySelector('#composer button[type="submit"]') as HTMLButtonElement,
  };
}

function submitForm(form: HTMLFormElement) {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('wireComposer — publicar un post', () => {
  it('submit con texto: POST /api/posts con CSRF + body correcto, y onPosted recibe el post', async () => {
    const { form, text, preview, fileInput } = setupForm();
    const serverPost = { id: 42, text: 'hola desde el test', parent_id: null };
    const fetchMock = mockFetch(serverPost, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);

    let posted: unknown = null;
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: (p) => { posted = p; } });

    text.value = 'hola desde el test';
    submitForm(form);

    await vi.waitFor(() => expect(posted).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/posts');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['x-twoitter-csrf']).toBe('1');
    const body = JSON.parse(opts.body as string);
    expect(body.text).toBe('hola desde el test');
    expect(body.parent_id).toBeNull();
    expect(body.media).toEqual([]);
    expect(posted).toEqual(serverPost);
  });

  it('la etiqueta de ubicación viaja en el body (location)', async () => {
    const { form, text, preview, fileInput, locInput } = setupForm();
    vi.stubGlobal('fetch', mockFetch({ id: 9 }, { status: 201 }));
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => {} });

    text.value = 'twoitt con sitio';
    locInput.value = 'Barcelona';
    submitForm(form);

    await vi.waitFor(() => expect(fetch as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled());
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.location).toBe('Barcelona');
    expect(body.lat).toBeNull();
    expect(body.lng).toBeNull();
  });

  it('reply: parent_id viaja en el body', async () => {
    const { form, text, preview, fileInput } = setupForm();
    vi.stubGlobal('fetch', mockFetch({ id: 7, parent_id: 3 }, { status: 201 }));

    let posted: unknown = null;
    wireComposer({ form, text, preview, fileInput, parentId: 3, onPosted: (p) => { posted = p; } });
    text.value = 'una respuesta';
    submitForm(form);

    await vi.waitFor(() => expect(posted).not.toBeNull());
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.parent_id).toBe(3);
  });

  it('tras publicar limpia el textarea y la preview', async () => {
    const { form, text, preview, fileInput } = setupForm();
    vi.stubGlobal('fetch', mockFetch({ id: 1 }, { status: 201 }));
    preview.innerHTML = '<div class="item">resto</div>';

    let done = false;
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => { done = true; } });
    text.value = 'algo';
    submitForm(form);

    await vi.waitFor(() => expect(done).toBe(true));
    expect(text.value).toBe('');
    expect(preview.innerHTML).toBe('');
  });

  it('el botón pasa a "publicando…" + disabled durante el envío y se restaura al terminar', async () => {
    const { form, text, preview, fileInput, submit } = setupForm();
    vi.stubGlobal('fetch', mockFetch({ id: 1 }, { status: 201 }));

    let posted = false;
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => { posted = true; } });
    text.value = 'algo';
    submitForm(form);

    // Síncrono tras el dispatch: el handler ya entró y marcó el botón antes
    // del primer await (el fetch mock aún no resolvió).
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('publicando…');

    await vi.waitFor(() => expect(posted).toBe(true));
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('publicar');
  });

  it('form vacío (sin texto/archivos/encuesta): no hace fetch', async () => {
    const { form, text, preview, fileInput } = setupForm();
    const fetchMock = mockFetch({}, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);

    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => {} });
    text.value = '   '; // solo espacios → trim a vacío
    submitForm(form);

    // dejar correr cualquier microtask por si acaso
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('error de red: onPosted NO se llama y el texto se conserva para reintentar', async () => {
    const { form, text, preview, fileInput, submit } = setupForm();
    vi.stubGlobal('fetch', mockFetch({ error: 'boom' }, { ok: false, status: 500 }));

    let posted = false;
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => { posted = true; } });
    text.value = 'no se debe perder';
    submitForm(form);

    // el botón se restaura (finally) aunque haya fallado → señal de que el
    // handler terminó.
    await vi.waitFor(() => expect(submit.disabled).toBe(false));
    expect(posted).toBe(false);
    expect(text.value).toBe('no se debe perder');
  });
});

describe('wireComposer — sin conexión (cola offline)', () => {
  it('navigator.onLine === false: no hace fetch, encola en el outbox y limpia el form', async () => {
    const { form, text, preview, fileInput, submit } = setupForm();
    const fetchMock = mockFetch({}, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('indexedDB', new IDBFactory());
    // happy-dom no deja escribir navigator.onLine → navigator falso mínimo.
    vi.stubGlobal('navigator', { onLine: false });

    let posted = false;
    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => { posted = true; } });
    text.value = 'escrito sin red';
    submitForm(form);

    await vi.waitFor(async () => expect(await outboxCount()).toBe(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).toBe(false); // no hay post del server que pintar
    expect(text.value).toBe(''); // el form se limpia como si hubiera publicado
    expect(submit.disabled).toBe(false);
    expect(document.getElementById('outboxChip')?.textContent).toBe('📤 1 por publicar');
  });

  it('la red cae justo al postear (status 0): el post acaba en el outbox', async () => {
    const { form, text, preview, fileInput } = setupForm();
    // fetch "falla" como api.js lo reporta: throw → api() devuelve status 0.
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('indexedDB', new IDBFactory());

    wireComposer({ form, text, preview, fileInput, parentId: null, onPosted: () => {} });
    text.value = 'se cayó la red';
    submitForm(form);

    await vi.waitFor(async () => expect(await outboxCount()).toBe(1));
    expect(text.value).toBe('');
  });
});

describe('wireComposer — encuesta', () => {
  // Monta el composer + el bloque de encuesta mínimo que collectPollOptions
  // espera (pollEl visible con .composer-poll-row inputs).
  function setupWithPoll() {
    document.body.innerHTML = `
      <form id="composer">
        <textarea id="text"></textarea>
        <div id="mediaPreview"></div>
        <input type="file" id="fileInput" />
        <div id="composerPoll" hidden>
          <div class="composer-poll-rows">
            <div class="composer-poll-row"><input value="" /></div>
            <div class="composer-poll-row"><input value="" /></div>
          </div>
          <button type="button" class="composer-poll-add"></button>
        </div>
        <button type="button" id="btnPoll"></button>
        <button type="submit">publicar</button>
      </form>
    `;
    return {
      form: document.getElementById('composer') as HTMLFormElement,
      text: document.getElementById('text') as HTMLTextAreaElement,
      preview: document.getElementById('mediaPreview') as HTMLDivElement,
      fileInput: document.getElementById('fileInput') as HTMLInputElement,
      pollEl: document.getElementById('composerPoll') as HTMLDivElement,
      pollBtn: document.getElementById('btnPoll') as HTMLButtonElement,
    };
  }

  it('con el bloque encuesta abierto y 2 opciones, el body lleva poll.options', async () => {
    const { form, text, preview, fileInput, pollEl, pollBtn } = setupWithPoll();
    vi.stubGlobal('fetch', mockFetch({ id: 9 }, { status: 201 }));

    let posted: unknown = null;
    wireComposer({ form, text, preview, fileInput, pollEl, pollBtn, parentId: null, onPosted: (p) => { posted = p; } });

    // abrir el bloque (no hidden) y rellenar las dos opciones
    pollEl.hidden = false;
    const inputs = pollEl.querySelectorAll('.composer-poll-row input');
    (inputs[0] as HTMLInputElement).value = 'paella';
    (inputs[1] as HTMLInputElement).value = 'pizza';
    text.value = '¿qué comemos?';
    submitForm(form);

    await vi.waitFor(() => expect(posted).not.toBeNull());
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.poll).toEqual({ options: ['paella', 'pizza'] });
  });

  it('bloque encuesta abierto con menos de 2 opciones: no hace fetch (validación cliente)', async () => {
    const { form, text, preview, fileInput, pollEl, pollBtn } = setupWithPoll();
    const fetchMock = mockFetch({}, { status: 201 });
    vi.stubGlobal('fetch', fetchMock);

    wireComposer({ form, text, preview, fileInput, pollEl, pollBtn, parentId: null, onPosted: () => {} });
    pollEl.hidden = false;
    const inputs = pollEl.querySelectorAll('.composer-poll-row input');
    (inputs[0] as HTMLInputElement).value = 'solo una';
    text.value = 'pregunta';
    submitForm(form);

    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
