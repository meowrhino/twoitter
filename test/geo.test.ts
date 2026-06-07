// Tests de la utilidad geográfica (haversine) usada por el geofence de sitios
// guardados. Función pura → tests sin BD.
import { describe, it, expect } from 'vitest';
import { haversineMeters } from '../src/geo';

describe('haversineMeters', () => {
  it('0 para el mismo punto', () => {
    expect(haversineMeters(41.3851, 2.1734, 41.3851, 2.1734)).toBe(0);
  });

  it('~111 km por grado de latitud', () => {
    const d = haversineMeters(41, 2, 42, 2);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });

  it('una distancia corta conocida (~44 m por 0.0004° de lat)', () => {
    const d = haversineMeters(41.3851, 2.1734, 41.3855, 2.1734);
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(48);
  });

  it('simétrica', () => {
    const a = haversineMeters(41.38, 2.17, 41.98, 2.82);
    const b = haversineMeters(41.98, 2.82, 41.38, 2.17);
    expect(a).toBeCloseTo(b, 6);
  });
});
