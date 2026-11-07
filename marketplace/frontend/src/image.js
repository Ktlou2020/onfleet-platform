// Shrink a photo on the phone before uploading: long side at most 1000 px,
// JPEG at 82% — typically 80–250 KB, quick on mobile data.
export async function resizeToDataUrl(file, max = 1000, quality = 0.82) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Choose a photo');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Couldn't read that photo"); });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}
