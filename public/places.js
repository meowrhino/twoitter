// ----- entry de la página /places (gestión de sitios guardados) -----
//
// Lista los sitios guardados (geofence) y permite renombrarlos, ajustar su radio
// o borrarlos. Solo el dueño (hoy = el único usuario autenticado). Página ligera
// como /compose: no carga timeline/render/gallery.

import { checkAuth, isAuthed } from './js/auth.js';
import { api } from './js/api.js';
import { toast, escapeHtml } from './js/utils.js';

const $ = (s) => document.querySelector(s);
const listEl = () => $('#placesList');

function placeRow(p) {
  const row = document.createElement('div');
  row.className = 'place-row';
  row.dataset.id = p.id;
  const mapUrl = `https://www.google.com/maps?q=${p.lat},${p.lng}`;
  row.innerHTML = `
    <input type="text" class="place-name loc-input" maxlength="120" value="${escapeHtml(p.name)}" aria-label="nombre del sitio" />
    <label class="place-radius">radio <input type="number" class="place-radius-input" min="10" max="100000" step="10" value="${Number(p.radius)}" aria-label="radio en metros" /> m</label>
    <a class="place-map" href="${mapUrl}" target="_blank" rel="noopener noreferrer" title="ver en el mapa">📍 ${escapeHtml(Number(p.lat).toFixed(4))}, ${escapeHtml(Number(p.lng).toFixed(4))}</a>
    <span class="grow"></span>
    <button type="button" class="place-save btn-primary">guardar</button>
    <button type="button" class="place-del link-btn">borrar</button>
  `;

  row.querySelector('.place-save').addEventListener('click', async () => {
    const name = row.querySelector('.place-name').value.trim();
    const radius = Number(row.querySelector('.place-radius-input').value);
    if (!name) { toast('el nombre no puede estar vacío', 'error'); return; }
    const { ok } = await api(`/api/places/${p.id}`, { method: 'PATCH', body: { name, radius } });
    toast(ok ? 'guardado' : 'no se pudo guardar', ok ? 'info' : 'error');
  });

  row.querySelector('.place-del').addEventListener('click', async () => {
    const { ok } = await api(`/api/places/${p.id}`, { method: 'DELETE' });
    if (ok) {
      row.remove();
      if (!listEl().querySelector('.place-row')) renderEmpty();
      toast('borrado');
    } else {
      toast('no se pudo borrar', 'error');
    }
  });

  return row;
}

function renderEmpty() {
  listEl().innerHTML = '<p class="places-empty">Aún no hay sitios guardados. Publica algo con una ubicación nombrada y aparecerá aquí.</p>';
}

async function load() {
  const { ok, data } = await api('/api/places');
  if (!ok || !Array.isArray(data)) {
    listEl().innerHTML = '<p class="places-empty">No se pudieron cargar los sitios.</p>';
    return;
  }
  if (data.length === 0) { renderEmpty(); return; }
  listEl().innerHTML = '';
  for (const p of data) listEl().appendChild(placeRow(p));
}

(async () => {
  await checkAuth();
  if (!isAuthed()) {
    location.href = '/login.html';
    return;
  }
  await load();
})();
