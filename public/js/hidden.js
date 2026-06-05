// ----- ocultar posts por-navegador via localStorage -----
//
// "Ocultar" es distinto a "borrar":
//   - borrar  → soft-delete server-side (todos los dispositivos lo dejan de ver)
//   - ocultar → sólo este navegador deja de mostrarlo (otros no se enteran)
//
// La idea es que puedas esconder ruido visual de tu feed sin tocar el
// contenido. Si recargas en otro device, vuelve a salir.

const KEY = 'twoitter_hidden_posts';

// Cargar perezosamente; usa Set para look-up O(1) y dedupe.
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    cache = new Set(Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify([...load()]));
  } catch {
    // localStorage puede fallar en modo incógnito estricto o quota llena.
    // No es crítico — el estado vive en memoria hasta recargar.
  }
}

export function isHidden(postId) {
  return load().has(Number(postId));
}

export function hide(postId) {
  load().add(Number(postId));
  persist();
}

export function unhide(postId) {
  load().delete(Number(postId));
  persist();
}

export function listHidden() {
  return [...load()];
}

export function clearHidden() {
  // Invalidar el cache a null en vez de vaciar el Set: así el siguiente
  // load() relee de storage. Útil para tests y para cuando se modifica
  // localStorage desde otra pestaña (storage event no implementado aquí).
  cache = null;
  try { localStorage.removeItem(KEY); } catch {}
}

// ----- presentación: placeholder revelable -----
//
// Un post oculto NO se quita del DOM: se colapsa a un stub "este post está
// oculto" (clicable). Click → .revealed muestra el contenido (peek). Para
// recuperarlo del todo, la barra de acciones ofrece "desocultar" (ver
// post-actions.js). Así nada queda atrapado sin retorno.

export function markPostHidden(postEl) {
  if (!postEl) return;
  postEl.classList.add('post-hidden');
  postEl.classList.remove('revealed');
  if (postEl.querySelector(':scope > .hidden-stub')) return; // ya tiene stub
  const stub = document.createElement('button');
  stub.type = 'button';
  stub.className = 'hidden-stub';
  stub.textContent = 'este post está oculto';
  stub.addEventListener('click', (e) => {
    // No frenamos la propagación: queremos que el click TAMBIÉN active el post
    // (listener global) para que la barra aparezca con "desocultar". Solo
    // alternamos el peek del contenido.
    postEl.classList.toggle('revealed');
  });
  postEl.insertBefore(stub, postEl.firstChild);
}

export function unmarkPostHidden(postEl) {
  if (!postEl) return;
  postEl.classList.remove('post-hidden', 'revealed');
  postEl.querySelector(':scope > .hidden-stub')?.remove();
}
