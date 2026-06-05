// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemStorage } from './helpers/mem-storage';

// happy-dom v20 no expone localStorage como global (stub Map-based, ver helper).
const ls = new MemStorage();
vi.stubGlobal('localStorage', ls);

const { isHidden, hide, unhide, listHidden, clearHidden } =
  await import('../public/js/hidden.js');

describe('hidden', () => {
  beforeEach(() => {
    ls.clear();
    clearHidden();
  });

  it('isHidden por defecto false para un id desconocido', () => {
    expect(isHidden(42)).toBe(false);
  });

  it('hide marca el id como oculto y persiste en localStorage', () => {
    hide(42);
    expect(isHidden(42)).toBe(true);
    expect(JSON.parse(ls.getItem('twoitter_hidden_posts')!)).toContain(42);
  });

  it('unhide quita el id', () => {
    hide(42);
    unhide(42);
    expect(isHidden(42)).toBe(false);
  });

  it('hide es idempotente (no duplica en el set)', () => {
    hide(7);
    hide(7);
    hide(7);
    expect(listHidden()).toEqual([7]);
  });

  it('listHidden devuelve todos los ids ocultos', () => {
    hide(1); hide(2); hide(3);
    expect(listHidden().sort()).toEqual([1, 2, 3]);
  });

  it('coerciona strings a number (defensivo contra localStorage corrupto)', () => {
    ls.setItem('twoitter_hidden_posts', JSON.stringify(['5', '8', 'no-numero']));
    clearHidden();
    // forzar recarga del cache leyendo de nuevo
    ls.setItem('twoitter_hidden_posts', JSON.stringify(['5', '8', 'no-numero']));
    expect(isHidden(5)).toBe(true);
    expect(isHidden(8)).toBe(true);
  });

  it('clearHidden vacía el set', () => {
    hide(1); hide(2);
    clearHidden();
    expect(listHidden()).toEqual([]);
  });
});
