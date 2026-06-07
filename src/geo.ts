// Utilidades geográficas (servidor). Espejo intencional de la copia cliente en
// public/js/utils.js (no hay bundler para compartir un módulo entre ambos).

const EARTH_RADIUS_M = 6371000;

// Distancia en metros entre dos puntos (lat/lng en grados) por la fórmula de
// haversine. Suficiente para el geofence (radios de decenas/cientos de metros).
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
