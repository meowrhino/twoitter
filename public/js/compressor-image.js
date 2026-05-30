// ----- compresión cliente: imagen (canvas → WebP) -----
//
// canvas.toBlob('image/webp', 0.85) + resize a IMAGE_MAX_DIM en el lado largo.
// createImageBitmap con imageOrientation='from-image' respeta EXIF rotation.
// No requiere nada especial (a diferencia del vídeo, que necesita SAB).

const IMAGE_QUALITY = 0.85;
const IMAGE_MAX_DIM = 2000;

export async function compressImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    // navegadores antiguos sin imageOrientation
    bitmap = await createImageBitmap(file);
  }
  const w0 = bitmap.width;
  const h0 = bitmap.height;
  const max = IMAGE_MAX_DIM;
  let w = w0, h = h0;
  if (w0 > max || h0 > max) {
    const r = w0 > h0 ? max / w0 : max / h0;
    w = Math.round(w0 * r);
    h = Math.round(h0 * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob null'))),
      'image/webp',
      IMAGE_QUALITY,
    );
  });
  return { blob, width: w, height: h };
}
