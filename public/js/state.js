// ----- estado compartido entre módulos -----
//
// El módulo que declara cada `let` es el único que lo muta (los otros
// solo lo importan con live binding). Para variables que necesitan ser
// modificadas desde fuera del módulo "dueño", se exporta una función
// setter explícita en ese módulo, no aquí.

export const PAGE = location.pathname.startsWith('/post/') ? 'post' : 'timeline';
// POST_ID es null si la URL no es /post/ o si el segmento no es un entero
// válido (ej. /post/abc). loadSinglePost lo trata como "post no encontrado"
// en vez de hacer un fetch a /api/posts/NaN que el server rechazaría.
function parsePostId() {
  if (PAGE !== 'post') return null;
  const raw = location.pathname.split('/')[2];
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && String(n) === raw ? n : null;
}
export const POST_ID = parsePostId();

export const SIDEBAR_KEY = 'twoitter_sidebar_hidden';
export const CSRF_HEADERS = { 'x-twoitter-csrf': '1' };

// Estado por composer (no contamina el nodo DOM con props ad-hoc).
// WeakMap permite GC automático cuando el <form> sale del DOM y ya nadie
// más lo referencia. shape: { pending: Map<localId, mediaState>, preview }
export const composerState = new WeakMap();
