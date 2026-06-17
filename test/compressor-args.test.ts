import { describe, it, expect } from 'vitest';
import { buildVideoArgs, shouldKeepOriginalVideo } from '../public/js/compressor-video.js';

const MB = 1024 * 1024;
const VIDEO_LIMIT = 50 * MB;

// El -vf de siempre (preset 720p): caja maxBox + truncado a par. Si cambia el
// preset, este string debe cambiar con él — es justo lo que protege el test de
// "cero regresión".
const SCALE =
  "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease," +
  'scale=trunc(iw/2)*2:trunc(ih/2)*2';

describe('buildVideoArgs', () => {
  it('sin trim ni crop: args idénticos al camino de siempre (cero regresión)', () => {
    const args = buildVideoArgs({ input: 'input.mp4', output: 'output.webm' });
    expect(args).toEqual([
      '-i', 'input.mp4',
      '-c:v', 'libvpx',
      '-crf', '10',
      '-b:v', '2000k',
      '-cpu-used', '4',
      '-lag-in-frames', '16',
      '-auto-alt-ref', '1',
      '-c:a', 'libvorbis',
      '-b:a', '128k',
      '-threads', '2',
      '-vf', SCALE,
      'output.webm',
    ]);
  });

  it('trim: añade -ss/-t justo después de -i (output-seeking), sin tocar el -vf', () => {
    const args = buildVideoArgs({
      input: 'in.webm', output: 'out.webm', trim: { start: 1.5, duration: 4 },
    });
    expect(args.slice(0, 6)).toEqual(['-i', 'in.webm', '-ss', '1.5', '-t', '4']);
    expect(args[args.indexOf('-vf') + 1]).toBe(SCALE); // sin crop
  });

  it('trim con duration 0: se ignora (no añade -ss/-t)', () => {
    const args = buildVideoArgs({
      input: 'in.webm', output: 'out.webm', trim: { start: 2, duration: 0 },
    });
    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-t');
  });

  it('crop: antepone crop= al scale, con dimensiones pares (libvpx)', () => {
    const args = buildVideoArgs({
      input: 'in.mp4', output: 'out.webm',
      crop: { x: 11, y: 7, w: 101, h: 51 }, srcW: 1920, srcH: 1080,
    });
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf.startsWith('crop=')).toBe(true);
    expect(vf.endsWith(SCALE)).toBe(true);
    const cropClause = vf.split(',')[0]; // "crop=100:50:10:6"
    const nums = cropClause.replace('crop=', '').split(':').map(Number);
    nums.forEach((n) => expect(n % 2).toBe(0));
    expect(cropClause).toBe('crop=100:50:10:6');
  });

  it('trim + crop combinados: ambos presentes y en orden correcto', () => {
    const args = buildVideoArgs({
      input: 'in.mp4', output: 'out.webm',
      trim: { start: 0.5, duration: 3 },
      crop: { x: 0, y: 0, w: 200, h: 200 }, srcW: 400, srcH: 400,
    });
    expect(args.slice(0, 6)).toEqual(['-i', 'in.mp4', '-ss', '0.5', '-t', '3']);
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf.startsWith('crop=200:200:0:0,')).toBe(true);
    expect(vf.endsWith(SCALE)).toBe(true);
  });
});

describe('shouldKeepOriginalVideo (gana el más pequeño)', () => {
  const base = {
    fileType: 'video/mp4',
    fileSize: 12 * MB,   // original eficiente (H.264)
    encodedSize: 30 * MB, // reencode VP8 hinchado
    sizeLimit: VIDEO_LIMIT,
    edited: false,
  };

  it('original mp4 más ligero que el WebM y sin editar → conserva original', () => {
    expect(shouldKeepOriginalVideo(base)).toBe(true);
  });

  it('original webm más ligero → también conserva original', () => {
    expect(shouldKeepOriginalVideo({ ...base, fileType: 'video/webm' })).toBe(true);
  });

  it('si hubo edición (crop/trim) → siempre reencode, aunque pese más', () => {
    expect(shouldKeepOriginalVideo({ ...base, edited: true })).toBe(false);
  });

  it('si el reencode salió más pequeño → reencode (caso típico móvil)', () => {
    expect(shouldKeepOriginalVideo({ ...base, fileSize: 40 * MB, encodedSize: 8 * MB })).toBe(false);
  });

  it('.mov/quicktime queda fuera (riesgo HEVC en Chrome/Firefox)', () => {
    expect(shouldKeepOriginalVideo({ ...base, fileType: 'video/quicktime' })).toBe(false);
  });

  it('original web-safe pero por encima del límite → reencode (no subir algo que el server rechaza)', () => {
    expect(shouldKeepOriginalVideo({ ...base, fileSize: 60 * MB, encodedSize: 70 * MB })).toBe(false);
  });

  it('sizeLimit aún sin cargar (0) no bloquea: el original ya es menor que el WebM', () => {
    expect(shouldKeepOriginalVideo({ ...base, sizeLimit: 0 })).toBe(true);
  });

  it('empate de tamaño → reencode (no estrictamente menor)', () => {
    expect(shouldKeepOriginalVideo({ ...base, fileSize: 30 * MB, encodedSize: 30 * MB })).toBe(false);
  });
});
