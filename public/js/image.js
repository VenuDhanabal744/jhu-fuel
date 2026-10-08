// Canvas helpers for photos (all on-device).

export async function loadImage(src) {
  const img = new Image();
  img.src = src instanceof Blob ? URL.createObjectURL(src) : src;
  await img.decode();
  return img;
}

/** Draw an image to a new canvas, scaled to `width` and rotated by `angle` degrees. */
export function toCanvas(img, { width = img.naturalWidth || img.width, angle = 0, background = null } = {}) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const scale = width / srcW;
  const w = srcW * scale;
  const hgt = srcH * scale;
  const rad = (angle * Math.PI) / 180;
  const cw = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(hgt * Math.sin(rad)));
  const ch = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(hgt * Math.cos(rad)));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -hgt / 2, w, hgt);
  return canvas;
}

const MAX_SIDE = 1280; // plenty for recognition, keeps uploads and stored photos small

/** Downscale + re-encode so uploads are fast and small (also strips EXIF/location). */
export async function prepareImage(file, maxSide = MAX_SIDE) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  let source = bitmap;
  let w;
  let hgt;
  if (bitmap) {
    w = bitmap.width;
    hgt = bitmap.height;
  } else {
    // Fallback for formats createImageBitmap can't decode directly.
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    source = img;
    w = img.naturalWidth;
    hgt = img.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Small JPEG thumbnail Blob for the food log. */
export async function thumbnail(dataUrl, size = 240) {
  const img = await loadImage(dataUrl);
  const scale = size / Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = toCanvas(img, { width: Math.round(img.naturalWidth * Math.min(1, scale)) });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}
