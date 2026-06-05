// Stub de localStorage para tests bajo happy-dom v20, que NO lo expone como
// global. Map-based, implementa la interfaz Storage. Uso típico al inicio del
// archivo de test (tras los imports):
//
//   import { MemStorage } from './helpers/mem-storage';
//   vi.stubGlobal('localStorage', new MemStorage());
//
// hidden.js accede a localStorage de forma perezosa (dentro de funciones), así
// que basta con stubear antes de que corra cualquier test (no hace falta antes
// del import estático del módulo bajo prueba).
export class MemStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
}
