import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const COOKIE_NAME = "twoitter_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

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

// constant-time string compare (avoids early-exit timing leaks)
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
