import { describe, it, expect } from 'vitest';
import { extractHashtags } from '../src/hashtags';

describe('extractHashtags', () => {
  it('returns empty array for null/empty', () => {
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags(undefined)).toEqual([]);
    expect(extractHashtags('')).toEqual([]);
  });

  it('extracts a single hashtag', () => {
    expect(extractHashtags('hola #mundo')).toEqual(['mundo']);
  });

  it('extracts multiple hashtags', () => {
    expect(extractHashtags('#foo bar #baz')).toEqual(['foo', 'baz']);
  });

  it('lowercases hashtags', () => {
    expect(extractHashtags('#Hola #MUNDO')).toEqual(['hola', 'mundo']);
  });

  it('deduplicates within the same text', () => {
    expect(extractHashtags('#foo #foo #FOO')).toEqual(['foo']);
  });

  it('supports unicode letters and numbers', () => {
    expect(extractHashtags('#niños #año2024 #españa')).toEqual([
      'niños', 'año2024', 'españa',
    ]);
  });

  it('allows underscores', () => {
    expect(extractHashtags('#foo_bar')).toEqual(['foo_bar']);
  });

  it('stops at punctuation', () => {
    expect(extractHashtags('mira #foo, también #bar.')).toEqual(['foo', 'bar']);
  });

  it('does not match # without trailing letter', () => {
    expect(extractHashtags('# solo o # vacio')).toEqual([]);
  });

  it('does not match in URLs (they break at /)', () => {
    // El regex captura solo [letras/números/_] tras #. Un # en una URL
    // (https://...#fragment) sí matchearía el fragmento, lo cual es
    // aceptable: el linkify del cliente decide el rendering.
    expect(extractHashtags('https://x.com/page#section')).toEqual(['section']);
  });
});
