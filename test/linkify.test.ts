// Tests de linkify(): hashtags + URLs externas + dominios meowrhino pelados.
// El COLOR (amarillo vs gold) lo decide ahora el CSS por el href
// (.post-text a.link[href*="meowrhino"]), así que aquí verificamos lo que el JS
// SÍ controla: que el enlace se genere bien, con class="link", el href correcto
// (https:// antepuesto si venía pelado) y que dominios meowrhino sin esquema se
// autolinken. Que el href contenga "meowrhino" es el proxy de que el CSS lo
// pintará en gold.
import { describe, it, expect } from 'vitest';
import { linkify } from '../public/js/utils.js';

describe('linkify', () => {
  it('autolinka un subdominio pelado de meowrhino.studio', () => {
    const out = linkify('mira lemuria.meowrhino.studio');
    expect(out).toContain('class="link"');
    expect(out).toContain('href="https://lemuria.meowrhino.studio"');
    expect(out).toContain('>lemuria.meowrhino.studio</a>');
  });

  it('autolinka meowrhino.github.io pelado (lo pintará el CSS en gold)', () => {
    const out = linkify('mi web meowrhino.github.io');
    expect(out).toContain('href="https://meowrhino.github.io"');
    expect(out).toContain('meowrhino'); // el [href*=meowrhino] del CSS → gold
  });

  it('autolinka el dominio raíz pelado meowrhino.studio', () => {
    const out = linkify('meowrhino.studio');
    expect(out).toContain('href="https://meowrhino.studio"');
  });

  it('un dominio externo pelado NO se linka (necesita esquema)', () => {
    const out = linkify('mira google.com');
    expect(out).not.toContain('<a');
    expect(out).toContain('google.com');
  });

  it('URL externa con esquema sí se linka, con class="link" (amarillo)', () => {
    const out = linkify('https://google.com/x');
    expect(out).toContain('class="link"');
    expect(out).toContain('href="https://google.com/x"');
    expect(out).toContain('target="_blank"');
  });

  it('URL interna con esquema explícito: el href lleva meowrhino → gold por CSS', () => {
    const out = linkify('https://meowrhino.github.io/foo');
    expect(out).toContain('href="https://meowrhino.github.io/foo"');
    expect(out).toContain('class="link"');
  });

  it('la puntuación final no entra en el enlace', () => {
    const out = linkify('entra en lemuria.meowrhino.studio.');
    expect(out).toContain('href="https://lemuria.meowrhino.studio"');
    expect(out).toContain('>lemuria.meowrhino.studio</a>.'); // el punto queda fuera
  });

  it('hashtags siguen funcionando junto a un dominio meowrhino', () => {
    const out = linkify('#lyoko en lemuria.meowrhino.studio');
    expect(out).toContain('class="hashtag"');
    expect(out).toContain('class="link"');
  });

  it('no inyecta HTML: el payload va escapado y solo el dominio se linka', () => {
    const out = linkify('<img src=x onerror=alert(1)> lemuria.meowrhino.studio');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('class="link"');
  });

  it('un subdominio multi-nivel también se autolinka', () => {
    const out = linkify('a.b.meowrhino.studio');
    expect(out).toContain('href="https://a.b.meowrhino.studio"');
  });
});
