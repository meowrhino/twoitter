// ----- estado compartido entre módulos -----
//
// El módulo que declara cada `let` es el único que lo muta (los otros
// solo lo importan con live binding). Para variables que necesitan ser
// modificadas desde fuera del módulo "dueño", se exporta una función
// setter explícita en ese módulo, no aquí.

export const PAGE = location.pathname.startsWith('/post/') ? 'post' : 'timeline';
export const POST_ID = PAGE === 'post' ? parseInt(location.pathname.split('/')[2]) : null;

export const SIDEBAR_KEY = 'twoitter_sidebar_hidden';
export const CSRF_HEADERS = { 'x-twoitter-csrf': '1' };

// Estado por composer (no contamina el nodo DOM con props ad-hoc).
// WeakMap permite GC automático cuando el <form> sale del DOM y ya nadie
// más lo referencia. shape: { pending: Map<localId, mediaState>, preview }
export const composerState = new WeakMap();
