const fs = require('fs');

// Magic bytes for allowed file types
const MAGIC = {
  pdf:  { bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 },          // %PDF
  jpeg: { bytes: [0xFF, 0xD8, 0xFF], offset: 0 },                 // JFIF/EXIF
  png:  { bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },           // PNG
  webp: { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 }            // WEBP (after RIFF)
};

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// HEIC/HEIF is ISO-BMFF: a box length, then 'ftyp', then a 4-char brand.
// iPhones write 'heic' by default; the rest appear on burst shots, edited
// images and Android HEIF. 'mif1'/'msf1' are the generic HEIF brands.
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);

function isHeif(buf) {
  if (buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIF_BRANDS.has(buf.toString('ascii', 8, 12));
}

function matchesMagic(buf, spec) {
  for (let i = 0; i < spec.bytes.length; i++) {
    if (buf[spec.offset + i] !== spec.bytes[i]) return false;
  }
  return true;
}

function detectMimeFromBuffer(buf) {
  if (matchesMagic(buf, MAGIC.pdf)) return 'application/pdf';
  if (matchesMagic(buf, MAGIC.jpeg)) return 'image/jpeg';
  if (matchesMagic(buf, MAGIC.png)) return 'image/png';
  if (buf.length >= 12 && matchesMagic(buf, { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }) && matchesMagic(buf, MAGIC.webp)) return 'image/webp';
  if (isHeif(buf)) return 'image/heic';
  return null;
}

/**
 * Validate an uploaded file by reading its magic bytes from disk.
 * Returns true if the file is one of the permitted types.
 * Allowed types: PDF, JPEG, PNG, WEBP.
 */
function validateUploadedFile(filePath, allowedMimes) {
  const allowed = new Set(allowedMimes || ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const detected = detectMimeFromBuffer(buf);
    return detected ? allowed.has(detected) : false;
  } catch {
    return false;
  }
}

/**
 * Express middleware — validates the magic bytes of req.file (or all files in req.files)
 * after multer writes them to disk. Deletes bad files and returns 400.
 */
function requireValidMime(allowedMimes) {
  return (req, res, next) => {
    const filesToCheck = [];
    if (req.file) filesToCheck.push(req.file);
    if (req.files) {
      if (Array.isArray(req.files)) filesToCheck.push(...req.files);
      else Object.values(req.files).forEach((arr) => { if (Array.isArray(arr)) filesToCheck.push(...arr); });
    }
    for (const f of filesToCheck) {
      if (f.path && !validateUploadedFile(f.path, allowedMimes)) {
        // Clean up ALL uploaded files to avoid orphans
        filesToCheck.forEach((file) => { try { fs.unlinkSync(file.path); } catch { /* gone */ } });
        return res.status(400).json({ error: 'Invalid file type. Only PDF, JPG, PNG, WEBP, and HEIC are accepted.' });
      }
    }
    next();
  };
}

module.exports = { validateUploadedFile, requireValidMime, detectMimeFromBuffer, isHeif };
