// ----- helpers genéricos: DOM, escape, formato, toast -----

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Dominio del ecosistema propio: los enlaces a él o a sus subdominios se pintan
// en gold (clase .internal-link) en vez del amarillo normal, y se autolinkan
// aunque se escriban SIN http:// (p.ej. lemuria.meowrhino.studio). Un único
// punto de verdad: cambia esto y cambian detección + color a la vez.
export const INTERNAL_DOMAIN = 'meowrhino.studio';

// ¿el host es el dominio interno o un subdominio suyo? (decide el color gold)
function isInternalHost(host) {
  const h = host.toLowerCase();
  return h === INTERNAL_DOMAIN || h.endsWith('.' + INTERNAL_DOMAIN);
}

// Hashtags + URLs → enlaces. El texto se HTML-escapa antes para evitar
// inyección; el regex de URL excluye '<' para no romper el HTML ya escapado.
//
// Dos clases de enlace se detectan:
//   1) URLs con esquema explícito (http/https), de cualquier dominio.
//   2) Dominios PELADOS de meowrhino.studio (sin esquema). Se limita a ese
//      ecosistema a propósito: cero falsos positivos (un "archivo.txt" suelto no
//      se linka). Todo lo demás necesita http(s)://.
// El COLOR (gold vs amarillo) lo decide el host de DESTINO, no cómo se escribió:
// https://lemuria.meowrhino.studio y lemuria.meowrhino.studio van ambos en gold.
export function linkify(text) {
  const esc = escapeHtml(text);
  let out = esc.replace(/#([\p{L}\p{N}_]+)/gu, (_, t) =>
    `<a class="hashtag" href="/?tag=${encodeURIComponent(t.toLowerCase())}">#${escapeHtml(t)}</a>`,
  );
  const URL_RE = /(https?:\/\/[^\s<]+|(?:[a-z0-9-]+\.)*meowrhino\.studio(?:\/[^\s<]*)?)/gi;
  out = out.replace(URL_RE, (raw) => {
    // Puntuación de cierre pegada al final: no forma parte del enlace
    // ("…studio." al cerrar una frase). No tocamos ) ni ] para no romper URLs
    // tipo wikipedia .../Foo_(bar).
    const m = /[.,;:!?]+$/.exec(raw);
    const trail = m ? m[0] : '';
    const u = trail ? raw.slice(0, -trail.length) : raw;
    const href = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    let host;
    try {
      const parsed = new URL(href.replace(/&amp;/g, '&'));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw;
      host = parsed.hostname;
    } catch { return raw; }
    const cls = isInternalHost(host) ? ' class="internal-link"' : '';
    return `<a${cls} href="${href}" target="_blank" rel="noopener noreferrer">${u}</a>${trail}`;
  });
  return out;
}

// formato europeo: 1032 → "1.032", 1032456 → "1.032.456"
const NUM_FMT = new Intl.NumberFormat('es-ES');
export const fmt = (n) => NUM_FMT.format(n);

// siempre en horas, con separador de millares (0h para < 1h)
export function hoursAgo(iso) {
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const hours = Math.floor((Date.now() - t) / 3600_000);
  return `${fmt(hours)}h`;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// Toast accesible: aria-live=polite anuncia el mensaje a lectores de
// pantalla sin interrumpir lo que estén leyendo.
export function toast(msg, type = 'info') {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ----- clasificación de media + helpers de frame/tiempo -----

// Tipo de media de un File según su MIME ('image' | 'video' | 'audio' | null).
// Único punto de verdad para "¿qué clase de media es este archivo?", compartido
// por attachFile (media.js) y el paste handler (composer.js).
export function mediaKindOf(file) {
  const t = file?.type || '';
  return t.startsWith('image/') ? 'image'
    : t.startsWith('video/') ? 'video'
    : t.startsWith('audio/') ? 'audio'
    : null;
}

// Espera a un frame de pintado (rAF), con fallback a setTimeout donde no hay
// requestAnimationFrame (tests headless). Para medir/animar tras un reflow.
export function nextFrame() {
  return new Promise((res) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => res());
    else setTimeout(res, 16);
  });
}

// Espera `ms` milisegundos.
export function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ¿El usuario pidió movimiento reducido? Se consulta por-llamada (reacciona si
// cambia el ajuste del SO). Guarda typeof window por si corre sin DOM (tests).
export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Curva y duración compartidas de las animaciones de altura (rail amarillo,
// acordeón de replies, composer inline). DEBEN coincidir para que se muevan
// "juntos"; centralizadas aquí para no tener el literal en 3 sitios. El token CSS
// --curve-standard espeja la misma curva (cliente y CSS no se pueden DRYear sin
// bundler, pero al menos el JS tiene una sola fuente).
export const STANDARD_CURVE = 'cubic-bezier(0.4, 0, 0.2, 1)';
export const ANIM_MS = 320;

// Distancia en metros entre dos puntos (lat/lng en grados), haversine. Espejo
// intencional de src/geo.ts (sin bundler no se puede compartir un módulo entre
// cliente y servidor). Lo usa el composer para el geofence de sitios guardados.
export function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
