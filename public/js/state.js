// ----- estado compartido entre módulos -----
//
// El módulo que declara cada `let` es el único que lo muta (los otros
// solo lo importan con live binding). Para variables que necesitan ser
// modificadas desde fuera del módulo "dueño", se exporta una función
// setter explícita en ese módulo, no aquí.

// Ya no hay vista "single-post" — la TL es un carrete plano y un link
// a un post es la URL /#<id>. El server redirige /post/:id (legado) con
// 301 a /#<id> (ver src/index.ts).

export const SIDEBAR_KEY = 'twoitter_sidebar_hidden';
export const CSRF_HEADERS = { 'x-twoitter-csrf': '1' };

// Estado por composer (no contamina el nodo DOM con props ad-hoc).
// WeakMap permite GC automático cuando el <form> sale del DOM y ya nadie
// más lo referencia. shape: { pending: Map<localId, mediaState>, preview }
export const composerState = new WeakMap();
