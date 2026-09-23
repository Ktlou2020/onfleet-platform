// Shrink a photograph before it leaves the phone.
//
// A modern handset takes a 4 MB photo. A technician on workshop signal
// uploading that, to look at a part they are holding, is the difference
// between a feature and a feature nobody uses. Resizing here rather than on
// the server fixes the upload as well as the display — the bytes are never
// sent in the first place — and the backend has no image library anyway.
//
// A part on a bench needs to be recognisable, not printable. A thousand pixels
// on the long edge is plenty for that and lands around 100–200 KB.

const MAX_EDGE = 1000;
const QUALITY = 0.8;

/**
 * Returns a resized JPEG File, or the original if it cannot be processed.
 *
 * Never throws. A photo that will not decode — an unusual format, a browser
 * without canvas, a file that is not really an image — is handed back
 * untouched so the upload still happens and the server can have the last
 * word. Refusing to upload because the resize failed would be worse than
 * uploading something large.
 */
export async function resizeImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  if (!file || !file.type?.startsWith('image/')) return file;

  try {
    const bitmap = await loadBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));

    // Already small enough: re-encoding would only lose quality for nothing.
    if (scale === 1 && file.size <= 400_000) {
      bitmap.close?.();
      return file;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    // If the "smaller" version is not smaller, keep the original.
    if (blob.size >= file.size) return file;

    return new File([blob], renameToJpeg(file.name), { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;
  }
}

function renameToJpeg(name) {
  const base = String(name || 'photo').replace(/\.[^.]+$/, '');
  return `${base}.jpg`;
}

async function loadBitmap(file) {
  // createImageBitmap honours EXIF orientation with imageOrientation set,
  // which matters: a photo taken in portrait otherwise arrives on its side.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default resizeImage;
