// ----- wrapper de fetch unificado -----
//
// Centraliza el patrón fetch + credentials + CSRF + JSON parsing + error
// handling. Antes había 9 fetch calls dispersos en composer/render/media/
// pages/auth/hashtags con headers ligeramente distintos, cada uno con su
// propio manejo de res.ok / res.json().catch. Consolidamos aquí.
//
// Devuelve siempre { ok, status, data } — NUNCA lanza. data es el JSON
// parseado o null (si el endpoint no devolvió JSON válido, no es lo común
// pero pasa con 5xx o 404 vacíos).
//
// Reglas:
// - GET por defecto. Métodos mutantes (POST/PUT/DELETE/PATCH) llevan
//   CSRF_HEADERS automáticamente.
// - Si body es objeto plano: JSON.stringify + content-type application/json.
// - Si body es Blob/ArrayBuffer/FormData/string: se pasa raw (uploads).
// - headers en opts se mergea EncIMA de los headers automáticos (puedes
//   sobreescribir content-type si subes un blob con su propio mime).
// - credentials: 'same-origin' siempre — necesario para que el browser mande
//   la cookie de sesión.

import { CSRF_HEADERS } from './state.js';

const RAW_BODY_TYPES = [Blob, ArrayBuffer, FormData];

function isRawBody(body) {
  if (body == null) return false;
  if (typeof body === 'string') return true;
  return RAW_BODY_TYPES.some((T) => body instanceof T);
}

/**
 * @param {string} path
 * @param {{
 *   method?: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH',
 *   body?: any,
 *   headers?: Record<string,string>,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
export async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const isMutating = method !== 'GET' && method !== 'HEAD';
  const body = opts.body;
  const sendJson = body !== undefined && body !== null && !isRawBody(body);

  const headers = {
    ...(isMutating ? CSRF_HEADERS : {}),
    ...(sendJson ? { 'content-type': 'application/json' } : {}),
    ...opts.headers,
  };

  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: sendJson ? JSON.stringify(body) : body,
      signal: opts.signal,
    });
  } catch (err) {
    // Network error / aborted. Tratamos como ok:false con status 0 para
    // que el caller no tenga que diferenciar entre "el server rechazó"
    // y "no se pudo enviar"; ambos casos terminan en toast de error.
    return { ok: false, status: 0, data: null };
  }

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
