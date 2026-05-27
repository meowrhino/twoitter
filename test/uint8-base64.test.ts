import { describe, it, expect } from 'vitest';
import { uint8ToBase64 } from '../src/media';

describe('uint8ToBase64', () => {
  it('matches btoa output for short ASCII bytes', () => {
    const u8 = new TextEncoder().encode('hello world');
    expect(uint8ToBase64(u8)).toBe(btoa('hello world'));
  });

  it('handles empty input', () => {
    expect(uint8ToBase64(new Uint8Array(0))).toBe('');
  });

  it('handles a single byte', () => {
    const u8 = new Uint8Array([65]); // 'A'
    expect(uint8ToBase64(u8)).toBe(btoa('A'));
  });

  it('handles bytes that span exactly one CHUNK boundary', () => {
    // CHUNK = 0x8000 = 32768. Generate 32768 bytes of value 0x42 ('B').
    const u8 = new Uint8Array(0x8000).fill(0x42);
    const expected = btoa(String.fromCharCode(0x42).repeat(0x8000));
    expect(uint8ToBase64(u8)).toBe(expected);
  });

  it('handles bytes that span multiple CHUNK boundaries (3 chunks)', () => {
    // 3 chunks = 98304 bytes. Mezcla bytes para que el chunking se note
    // si está mal implementado (cada chunk debe concatenarse en orden).
    const SIZE = 3 * 0x8000 + 17; // 3 chunks + tail
    const u8 = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) u8[i] = i % 256;
    // Calcular esperado byte a byte para validar
    let expected = '';
    for (let i = 0; i < SIZE; i++) expected += String.fromCharCode(u8[i]);
    expect(uint8ToBase64(u8)).toBe(btoa(expected));
  });

  it('handles full byte range 0-255 in a single chunk', () => {
    const u8 = new Uint8Array(256);
    for (let i = 0; i < 256; i++) u8[i] = i;
    let expected = '';
    for (let i = 0; i < 256; i++) expected += String.fromCharCode(i);
    expect(uint8ToBase64(u8)).toBe(btoa(expected));
  });

  it('does not throw on large inputs (1 MB)', () => {
    // El punto del chunking es evitar stack overflow de fromCharCode.apply
    // con buffers grandes. 1MB es suficientemente grande para detectar regresión.
    const u8 = new Uint8Array(1024 * 1024);
    for (let i = 0; i < u8.length; i++) u8[i] = i & 0xff;
    expect(() => uint8ToBase64(u8)).not.toThrow();
    // El resultado debe ser un base64 válido y de longitud esperada (~4/3 del input).
    const result = uint8ToBase64(u8);
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.length).toBeGreaterThan(1024 * 1024 * 4 / 3 - 10);
    expect(result.length).toBeLessThan(1024 * 1024 * 4 / 3 + 10);
  });
});
