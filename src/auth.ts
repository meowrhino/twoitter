import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const COOKIE_NAME = "twoitter_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

// Cookie de votante anónimo para encuestas. Identidad opaca: un UUID v4
// firmado con HMAC(AUTH_SECRET). No es PII: no se cruza con IP ni con la
// cookie de auth. Cookie de larga duración para que un mismo dispositivo
// siga siendo "el mismo votante" entre sesiones.
//
// Tope 400 días: es el máximo que permite la spec de cookies (Chrome lo
// capa ahí) y Hono lo valida — setCookie LANZA si Max-Age > 34.560.000s.
// Antes estaba a 2 años (730 días) y reventaba el PRIMER voto de cada
// visitante con un 500 "internal", porque el primer voto es justo cuando
// se emite la cookie. 400 días es de sobra para el caso de uso.
const VOTER_COOKIE_NAME = "tv_id";
const VOTER_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

// Bindings mínimas que auth necesita. Cualquier Hono Context con un Bindings
// que contenga estas dos claves (más extras) es compatible — usamos un
// genérico con constraint en lugar de un tipo fijo para no chocar con el
// Bindings completo de la app (que añade DB, STORAGE, ASSETS).
type AuthEnv = { PASSWORD: string; AUTH_SECRET: string };

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(msg),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Comparación en tiempo constante (sin early-exit que filtre por timing).
// Antes hacía `if (a.length !== b.length) return false` ANTES del bucle: eso
// devolvía en tiempo distinto según coincidiera o no la longitud, filtrando la
// longitud de la contraseña por tiempo de respuesta del login. Ahora siempre
// recorremos la cadena más larga (acumulando la diferencia de longitud en el
// resultado), así el trabajo no depende de si las longitudes coinciden. Sigue
// devolviendo false ante cualquier diferencia (longitud o contenido).
// Nota honesta: en JS puro la constant-time perfecta no existe (JIT/GC), pero
// esto elimina la fuga obvia y de bajo coste; suficiente para un login con
// un único secreto.
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  // Sembramos con la diferencia de longitud: si difieren, result ya es != 0 y
  // ninguna combinación de chars puede volver a ponerlo a 0.
  let result = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    // charCodeAt fuera de rango devuelve NaN; (NaN >>> 0 ? ...) lo evitamos con || 0.
    const ca = a.charCodeAt(i) || 0;
    const cb = b.charCodeAt(i) || 0;
    result |= ca ^ cb;
  }
  return result === 0;
}

export async function makeToken(secret: string): Promise<string> {
  const issued = Date.now().toString();
  const sig = await hmac(secret, issued);
  return `${issued}.${sig}`;
}

export async function verifyToken(
  secret: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const [issued, sig] = token.split(".");
  if (!issued || !sig) return false;
  const expected = await hmac(secret, issued);
  if (!timingSafeEqual(expected, sig)) return false;
  const age = Date.now() - parseInt(issued);
  return age >= 0 && age < COOKIE_MAX_AGE * 1000;
}

export async function setAuthCookie(c: Context, secret: string) {
  const token = await makeToken(secret);
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
}

export function clearAuthCookie(c: Context) {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function isAuthed<E extends AuthEnv>(
  c: Context<{ Bindings: E }>,
): Promise<boolean> {
  const token = getCookie(c, COOKIE_NAME);
  return verifyToken(c.env.AUTH_SECRET, token);
}

export function requireAuth<E extends AuthEnv>() {
  return async (c: Context<{ Bindings: E }>, next: Next) => {
    if (!(await isAuthed(c))) {
      const accepts = c.req.header("accept") || "";
      if (accepts.includes("application/json") || c.req.path.startsWith("/api/")) {
        return c.json({ error: "no autenticado" }, 401);
      }
      return c.redirect("/login.html");
    }
    await next();
  };
}

// ---------- voter cookie (anónimo, para encuestas) ----------

// Lee la cookie tv_id si es válida (firma OK). Devuelve null si no hay
// cookie o la firma no cuadra. NO emite cookies — solo lectura. Útil para
// resolver `my_vote_id` en /api/posts sin tener que crear cookie a cada
// visitante que pasa por el feed.
export async function readVoterId<E extends AuthEnv>(
  c: Context<{ Bindings: E }>,
): Promise<string | null> {
  const raw = getCookie(c, VOTER_COOKIE_NAME);
  if (!raw) return null;
  const [id, sig] = raw.split(".");
  if (!id || !sig) return null;
  const expected = await hmac(c.env.AUTH_SECRET, id);
  if (!timingSafeEqual(expected, sig)) return null;
  return id;
}

// Igual que readVoterId pero, si no existe cookie válida, crea una nueva
// (UUID v4 firmado) y la emite con Set-Cookie. Devuelve siempre un id.
// Pensado para el endpoint POST /poll/vote: el primer voto del visitante
// también "inscribe" su identidad anónima.
export async function getOrIssueVoterId<E extends AuthEnv>(
  c: Context<{ Bindings: E }>,
): Promise<string> {
  const existing = await readVoterId(c);
  if (existing) return existing;
  // crypto.randomUUID está disponible en Workers desde hace tiempo.
  const id = crypto.randomUUID();
  const sig = await hmac(c.env.AUTH_SECRET, id);
  setCookie(c, VOTER_COOKIE_NAME, `${id}.${sig}`, {
    httpOnly: true,
    secure: true,
    // SameSite Lax: la cookie se manda en navegación normal y en POSTs
    // same-site. Suficiente para votar desde la propia página, y bloquea
    // que un sitio externo intente forzar votos vía submission cross-site
    // (además de la guarda CSRF de header).
    sameSite: "Lax",
    maxAge: VOTER_COOKIE_MAX_AGE,
    path: "/",
  });
  return id;
}
