import { describe, it, expect } from 'vitest';
import { buildMediaKey, classifyContentType, maxBytesFor } from '../src/media';

describe('classifyContentType', () => {
  it('classifies common image types', () => {
    expect(classifyContentType('image/jpeg')).toEqual({ kind: 'image', ext: 'jpg' });
    expect(classifyContentType('image/png')).toEqual({ kind: 'image', ext: 'png' });
    expect(classifyContentType('image/gif')).toEqual({ kind: 'image', ext: 'gif' });
    expect(classifyContentType('image/webp')).toEqual({ kind: 'image', ext: 'webp' });
    expect(classifyContentType('image/avif')).toEqual({ kind: 'image', ext: 'avif' });
  });

  it('classifies common video types', () => {
    expect(classifyContentType('video/mp4')).toEqual({ kind: 'video', ext: 'mp4' });
    expect(classifyContentType('video/webm')).toEqual({ kind: 'video', ext: 'webm' });
    expect(classifyContentType('video/quicktime')).toEqual({ kind: 'video', ext: 'mov' });
  });

  it('classifies common audio types', () => {
    expect(classifyContentType('audio/webm')).toEqual({ kind: 'audio', ext: 'webm' });
    expect(classifyContentType('audio/ogg')).toEqual({ kind: 'audio', ext: 'ogg' });
    expect(classifyContentType('audio/mpeg')).toEqual({ kind: 'audio', ext: 'mp3' });
    expect(classifyContentType('audio/mp4')).toEqual({ kind: 'audio', ext: 'm4a' });
    expect(classifyContentType('audio/x-m4a')).toEqual({ kind: 'audio', ext: 'm4a' });
    expect(classifyContentType('audio/wav')).toEqual({ kind: 'audio', ext: 'wav' });
    expect(classifyContentType('audio/x-wav')).toEqual({ kind: 'audio', ext: 'wav' });
  });

  it('rejects unknown content types', () => {
    expect(classifyContentType('application/pdf')).toBeNull();
    expect(classifyContentType('text/plain')).toBeNull();
    expect(classifyContentType('image/svg+xml')).toBeNull();
    expect(classifyContentType('')).toBeNull();
  });
});

describe('buildMediaKey', () => {
  it('starts with folder + year/month path', () => {
    const k = buildMediaKey('images', 'jpg');
    expect(k).toMatch(/^images\/\d{2}\/\d{2}\//);
  });

  it('uses 12 random bytes hex (24 chars) + ext', () => {
    const k = buildMediaKey('videos', 'mp4');
    expect(k).toMatch(/^videos\/\d{2}\/\d{2}\/[0-9a-f]{24}\.mp4$/);
  });

  it('sanitizes ext: strips non-alphanumeric', () => {
    const k = buildMediaKey('thumbs', '../evil.sh');
    // sólo letras/números: "evilsh"
    expect(k).toMatch(/\.evilsh$/);
  });

  it('falls back to "bin" if ext sanitizes to empty', () => {
    const k = buildMediaKey('images', '...');
    expect(k).toMatch(/\.bin$/);
  });

  it('lowercases the ext', () => {
    const k = buildMediaKey('images', 'JPG');
    expect(k).toMatch(/\.jpg$/);
  });

  it('produces different keys on consecutive calls (randomness)', () => {
    const a = buildMediaKey('images', 'jpg');
    const b = buildMediaKey('images', 'jpg');
    expect(a).not.toBe(b);
  });
});

describe('maxBytesFor', () => {
  // límites actuales: 10 MB imagen, 50 MB vídeo, 25 MB audio. estos números
  // son el cap tras la compresión cliente; el audio coincide con el límite
  // de Workers AI Whisper en la request (~25 MB).
  it('caps images at 10 MB', () => {
    expect(maxBytesFor('image')).toBe(10 * 1024 * 1024);
  });
  it('caps videos at 50 MB', () => {
    expect(maxBytesFor('video')).toBe(50 * 1024 * 1024);
  });
  it('caps audios at 25 MB', () => {
    expect(maxBytesFor('audio')).toBe(25 * 1024 * 1024);
  });
});
