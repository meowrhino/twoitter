import { describe, it, expect } from 'vitest';
import { buildVideoArgs } from '../public/js/compressor-video.js';

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
