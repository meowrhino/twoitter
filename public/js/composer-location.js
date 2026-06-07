// ----- control de ubicación del composer -----
//
// Un botón "ubicación" que captura las coords GPS vía la Geolocation API. Sólo
// tras capturarlas aparece un campo opcional para nombrar el sitio (+ una ✕
// para quitar la ubicación). Si escribes un nombre, se muestra; si no, el post
// enseña las coordenadas. El link del pie abre en una app de mapa.
//
// Compartido por el composer principal (markup en index.html) y el inline
// (markup inyectado vía locationControlMarkup()), igual que composer-poll.js.
// La parte de GPS NO es testeable headless (igual que F6/F7) → se verifica en
// Brave.

import { toast, haversineMeters } from './utils.js';
import { savedPlaces } from './state.js';

// Markup del control. Se usa tal cual en el composer inline; el principal lo
// replica en index.html (con ids para los tests/labels). El input y la ✕ nacen
// ocultos: aparecen al capturar coords.
export function locationControlMarkup() {
  return `
    <button type="button" class="geo-btn rec-btn" aria-label="añadir ubicación">ubicación</button>
    <input type="text" class="loc-input" placeholder="nombre del sitio (opcional)" maxlength="120" aria-label="nombre del sitio" hidden />
    <button type="button" class="geo-clear link-btn" aria-label="quitar ubicación" title="quitar ubicación" hidden>✕</button>
  `;
}

// Cablea el control dentro de un form ya en el DOM. Devuelve { getValue, reset }.
// getValue() → { location, lat, lng } listos para el payload del post.
export function wireLocation(form) {
  const btn = form.querySelector('.geo-btn');
  const input = form.querySelector('.loc-input');
  const clearBtn = form.querySelector('.geo-clear');
  // Coords capturadas por el botón. El nombre (input) es aparte y opcional.
  let coords = { lat: null, lng: null };
  const restLabel = btn ? btn.textContent : 'ubicación';

  const coordLabel = (lat, lng) => `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

  function showCaptured(lat, lng) {
    coords = { lat, lng };
    if (btn) {
      btn.classList.add('has-geo');
      btn.textContent = coordLabel(lat, lng);
    }
    if (input) {
      input.hidden = false;
      // Geofence: si estás dentro del radio de un sitio guardado, autorrellena
      // su nombre (editable). No pisa un nombre ya escrito.
      const near = findNearbySaved(lat, lng);
      if (near && !input.value.trim()) input.value = near.name;
      input.focus();
    }
    if (clearBtn) clearBtn.hidden = false;
  }

  // Primer sitio guardado cuyo radio contiene el punto, o null. Espejo cliente de
  // findNearbyPlace (src/db.ts); la lista vive en savedPlaces (state.js).
  function findNearbySaved(lat, lng) {
    for (const p of savedPlaces) {
      if (haversineMeters(lat, lng, p.lat, p.lng) <= p.radius) return p;
    }
    return null;
  }

  function clearCaptured() {
    coords = { lat: null, lng: null };
    if (btn) {
      btn.classList.remove('has-geo');
      btn.textContent = restLabel;
      btn.disabled = false;
    }
    if (input) {
      input.value = '';
      input.hidden = true;
    }
    if (clearBtn) clearBtn.hidden = true;
  }

  if (btn) {
    btn.addEventListener('click', () => {
      if (!('geolocation' in navigator)) {
        toast('tu navegador no soporta geolocalización', 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'ubicando…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          btn.disabled = false;
          showCaptured(pos.coords.latitude, pos.coords.longitude);
        },
        (err) => {
          btn.disabled = false;
          // Si ya había coords (reintento), restaurar su etiqueta; si no, el reposo.
          btn.textContent = coords.lat != null ? coordLabel(coords.lat, coords.lng) : restLabel;
          const denied = err && err.code === err.PERMISSION_DENIED;
          toast(denied ? 'permiso de ubicación denegado' : 'no se pudo obtener la ubicación', 'error');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    });
  }
  if (clearBtn) clearBtn.addEventListener('click', clearCaptured);

  return {
    getValue() {
      const location = (input?.value || '').trim() || null;
      return { location, lat: coords.lat, lng: coords.lng };
    },
    reset: clearCaptured,
  };
}
