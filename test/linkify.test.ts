// Tests de linkify(): hashtags + URLs externas + dominios internos.
// Lo nuevo: dominios PELADOS de meowrhino.studio se autolinkan (sin http://) y
// cualquier enlace a *.meowrhino.studio lleva class="internal-link" (gold),
// mientras que el resto necesita esquema y va sin clase (amarillo).
import { describe, it, expect } from 'vitest';
import { linkify } from '../public/js/utils.js';

describe('linkify', () => {
  it('autolinka un subdominio pelado de meowrhino.studio como interno (gold)', () => {
    const out = linkify('mira lemuria.meowrhino.studio');
    expect(out).toContain('class="internal-link"');
    expect(out).toContain('href="https://lemuria.meowrhino.studio"');
    expect(out).toContain('>lemuria.meowrhino.studio</a>');
  });

  it('autolinka el dominio raíz pelado meowrhino.studio', () => {
    const out = linkify('meowrhino.studio');
    expect(out).toContain('class="internal-link"');
    expect(out).toContain('href="https://meowrhino.studio"');
  });

  it('un dominio externo pelado NO se linka (necesita esquema)', () => {
    const out = linkify('mira google.com');
    expect(out).not.toContain('<a');
    expect(out).toContain('google.com');
  });

  it('URL externa con esquema sí se linka, sin clase interna (amarillo)', () => {
    const out = linkify('https://google.com/x');
    expect(out).toContain('href="https://google.com/x"');
    expect(out).not.toContain('internal-link');
    expect(out).toContain('target="_blank"');
  });

  it('URL interna con esquema explícito también va en gold (color = host destino)', () => {
    const out = linkify('https://lemuria.meowrhino.studio/foo');
    expect(out).toContain('class="internal-link"');
    expect(out).toContain('href="https://lemuria.meowrhino.studio/foo"');
  });

  it('la puntuación final no entra en el enlace', () => {
    const out = linkify('entra en lemuria.meowrhino.studio.');
    expect(out).toContain('href="https://lemuria.meowrhino.studio"');
    expect(out).toContain('>lemuria.meowrhino.studio</a>.'); // el punto queda fuera
  });

  it('hashtags siguen funcionando junto a un dominio interno', () => {
    const out = linkify('#lyoko en lemuria.meowrhino.studio');
    expect(out).toContain('class="hashtag"');
    expect(out).toContain('class="internal-link"');
  });

  it('no inyecta HTML: el payload va escapado y solo el dominio se linka', () => {
    const out = linkify('<img src=x onerror=alert(1)> lemuria.meowrhino.studio');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('class="internal-link"');
  });

  it('un subdominio multi-nivel también es interno', () => {
    const out = linkify('a.b.meowrhino.studio');
    expect(out).toContain('class="internal-link"');
    expect(out).toContain('href="https://a.b.meowrhino.studio"');
  });
});
