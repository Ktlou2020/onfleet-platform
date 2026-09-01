'use strict';

/**
 * Converts an uploaded HEIC/HEIF file to JPEG in place.
 *
 * iPhones photograph in HEIC by default, so staff and riders capturing a
 * document with a phone were refused outright by the mime whitelist. Accepting
 * HEIC alone would only move the problem downstream: no browser except Safari
 * renders it, so the file would upload and then fail to display for whoever
 * had to review it. Converting at upload means every consumer — the admin
 * review screens, the rider portal, PDF exports — deals with an ordinary JPEG
 * and needs no knowledge that HEIC was ever involved.
 *
 * heic-convert is pure JavaScript (libheif via wasm). Slower than a native
 * codec, but the alternative builds against libvips/libheif, which the
 * Alpine runtime image has no toolchain for.
 */

const fs = require('fs');
const path = require('path');
const { isHeif } = require('./validateUpload');

// Quality is a deliberate trade: these are photographs of ID documents and
// payslips that a human has to read, so legibility matters more than bytes.
const JPEG_QUALITY = 0.92;

function readHeader(filePath, bytes = 16) {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, bytes, 0); } finally { fs.closeSync(fd); }
  return buf;
}

/**
 * If `file` is HEIC, rewrites it as JPEG and mutates the multer file object to
 * match (path, filename, mimetype, size) so callers persist the real stored
 * file rather than the one that was posted. No-op for anything else.
 *
 * Returns true when a conversion happened.
 */
async function convertHeicInPlace(file) {
  if (!file || !file.path || !fs.existsSync(file.path)) return false;
  if (!isHeif(readHeader(file.path))) return false;

  // Required lazily: the wasm build is heavy, and the overwhelming majority of
  // uploads are never HEIC, so a process that handles none never loads it.
  const convert = require('heic-convert');

  const input = fs.readFileSync(file.path);
  const output = Buffer.from(await convert({ buffer: input, format: 'JPEG', quality: JPEG_QUALITY }));

  const dir = path.dirname(file.path);
  const base = path.basename(file.path, path.extname(file.path));
  const jpegName = `${base}.jpg`;
  const jpegPath = path.join(dir, jpegName);

  fs.writeFileSync(jpegPath, output);
  // Only remove the original once the replacement is safely on disk, and don't
  // fail the upload if that unlink doesn't work — the JPEG is what matters.
  if (jpegPath !== file.path) {
    try { fs.unlinkSync(file.path); } catch { /* leave the original behind */ }
  }

  file.path = jpegPath;
  file.filename = jpegName;
  file.mimetype = 'image/jpeg';
  file.size = output.length;
  // originalname keeps the rider's own filename but must not still claim .heic,
  // since it is shown in the UI and used to pick a download extension.
  if (file.originalname) {
    file.originalname = `${path.basename(file.originalname, path.extname(file.originalname))}.jpg`;
  }
  return true;
}

/** Express middleware: converts req.file and any req.files before the route runs. */
function convertHeicUploads() {
  return async (req, res, next) => {
    try {
      const files = [];
      if (req.file) files.push(req.file);
      if (req.files) {
        if (Array.isArray(req.files)) files.push(...req.files);
        else Object.values(req.files).forEach((arr) => { if (Array.isArray(arr)) files.push(...arr); });
      }
      for (const f of files) await convertHeicInPlace(f);
      next();
    } catch (err) {
      console.error('[heic] conversion failed:', err.message);
      res.status(400).json({ error: 'That photo could not be processed. Please try again, or save it as JPG first.' });
    }
  };
}

module.exports = { convertHeicInPlace, convertHeicUploads };
