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

// Límites de encuesta. Defaults sensatos; checkAuth() los sobreescribe con los
// del server (/api/me) → UNA sola fuente de verdad (src/index.ts). Es un objeto
// mutable (no se reasigna el binding), así que los módulos que lo importan ven
// los valores ya actualizados después de checkAuth.
export const POLL_LIMITS = { min: 2, max: 10, optLen: 80 };

// Límites de bloques de letras (lyrics). Mismo patrón mutable que
// POLL_LIMITS: defaults sensatos que checkAuth() sobreescribe con /api/me.
export const LYRICS_LIMITS = { min: 1, max: 6, labelLen: 40, textLen: 20000, sourceLen: 300 };

// Topes de tamaño de upload (bytes) por tipo. Mismo patrón que POLL_LIMITS:
// defaults sensatos que checkAuth() sobreescribe con los del server (/api/me).
// Permiten avisar al usuario antes de subir; el server los revalida.
export const MEDIA_LIMITS = { image: 10485760, video: 52428800, audio: 26214400 };

// Sitios guardados (geofence). checkAuth() los rellena desde /api/places (mismo
// patrón mutable-no-reasignado que POLL_LIMITS: se vacía y se rellena en sitio,
// así los importadores ven el contenido actual por live binding). El composer
// los lee al capturar GPS para autorrellenar el nombre del sitio.
export const savedPlaces = [];

// Estado por composer (no contamina el nodo DOM con props ad-hoc).
// WeakMap permite GC automático cuando el <form> sale del DOM y ya nadie
// más lo referencia. shape: { pending: Map<localId, mediaState>, preview }
export const composerState = new WeakMap();
