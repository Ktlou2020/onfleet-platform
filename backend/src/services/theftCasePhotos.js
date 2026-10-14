'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pgDb = require('../pgDb');
const storageService = require('./storageService');
const UPLOAD_DIRS = require('../uploadPaths');
const { hybridStorage } = require('../utils/hybridStorage');

// Photographs attached to a theft case: sightings while it is open, and the
// evidence of how it ended when it is closed.
//
// WHY THESE DO NOT LIVE UNDER THE PUBLIC UPLOAD TREE
//
// app.js serves every file under UPLOAD_DIRS.base at /uploads/<path> with no
// authorization check at all. Its own comment is honest about what defends
// those files: an unguessable generated filename, and nothing else. That is a
// posture to stop extending rather than one to add theft evidence to.
//
// These photographs carry a registration, a place, a date and often the
// inside of somebody's yard. And the platform is multi-tenant: on Pillion,
// one fleet owner's case must not be one guessed URL away from another's.
// Filename obscurity is not a tenancy boundary.
//
// So they are written beside the public tree instead of inside it — same
// volume, so they inherit whatever durability UPLOAD_DIR was pointed at — and
// served only by the scoped endpoints in routes/tracking.js and routes/fleet.js,
// which check who is asking and which cases they are allowed to see. app.js
// additionally refuses anything under `private/`, so the object-store path
// cannot quietly reopen what the disk path closes.
const PRIVATE_BASE = path.join(UPLOAD_DIRS.base, '..', 'private');
const PHOTO_DIR = path.join(PRIVATE_BASE, 'theft-case-photos');
const OBJECT_PREFIX = 'private/theft-case-photos';

fs.mkdirSync(PHOTO_DIR, { recursive: true });

const STAGES = ['sighting', 'outcome'];

// Twelve is not a technical limit. It is enough for a recovery — the bike, its
// plate, the damage, where it was found — and few enough that a case page
// still loads on a phone at the roadside, which is where it is read.
const MAX_PER_CASE = 12;

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * One multer instance, shared by the operator console and the fleet portal.
 *
 * Both consoles accept the same files under the same limits on purpose: a
 * photograph of a recovered bike is the same evidence whoever uploaded it, and
 * two configurations would drift until one console accepted something the
 * other would not display.
 */
const upload = multer({
  storage: hybridStorage(PHOTO_DIR, OBJECT_PREFIX, (req, file) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    return `case-${req.params.id || 'x'}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    // Carries its own status: app.js's handler maps multer's own error codes
    // to 400, but a plain Error from a fileFilter falls through to 500, and
    // "you attached a PDF" is not a server fault.
    const e = new Error('That file is not an image');
    e.status = 400;
    cb(e);
  },
});

/** Best-effort removal of a file accepted by multer before the row was written. */
async function discard(file) {
  if (!file) return;
  if (file.path) { try { fs.unlinkSync(file.path); } catch { /* best effort */ } }
  if (storageService.isConfigured() && file.filename) {
    try { await storageService.deleteObject(`${OBJECT_PREFIX}/${file.filename}`); } catch { /* best effort */ }
  }
}

function shape(row, urlBase) {
  return {
    id: row.id,
    case_id: row.case_id,
    caption: row.caption || null,
    stage: row.stage,
    original_name: row.original_name || null,
    created_at: row.created_at,
    uploaded_by: row.uploaded_by || null,
    url: `${urlBase}/${row.case_id}/photos/${row.id}/image`,
  };
}

async function countForCase(caseId, db = pgDb) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM theft_case_photos WHERE case_id = $1', [caseId]);
  return rows[0].n;
}

/** The photographs on a case, oldest first — the order the story happened in. */
async function forCase(caseId, urlBase, db = pgDb) {
  const { rows } = await db.query(
    `SELECT p.*, u.full_name AS uploaded_by
       FROM theft_case_photos p
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.case_id = $1
      ORDER BY p.created_at, p.id`, [caseId]);
  return rows.map((r) => shape(r, urlBase));
}

/**
 * Attach an uploaded file to a case.
 *
 * Throws with a `status` the routes pass straight through, so the two consoles
 * cannot disagree about what counts as too many or a bad stage.
 */
async function record({ caseId, file, caption = null, stage = 'sighting', actorId, urlBase, db = pgDb }) {
  if (!file) {
    const e = new Error('No photograph was uploaded');
    e.status = 400;
    throw e;
  }
  if (!STAGES.includes(stage)) {
    const e = new Error(`"${stage}" is not a stage a photograph can be attached at`);
    e.status = 400;
    throw e;
  }
  if (await countForCase(caseId, db) >= MAX_PER_CASE) {
    const e = new Error(`That case already has ${MAX_PER_CASE} photographs`);
    e.status = 409;
    throw e;
  }

  const { rows } = await db.query(
    `INSERT INTO theft_case_photos (case_id, file_path, original_name, caption, stage, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [caseId, file.filename, file.originalname || null, caption || null, stage, actorId]);

  const { rows: withName } = await db.query(
    `SELECT p.*, u.full_name AS uploaded_by FROM theft_case_photos p
       LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [rows[0].id]);
  return shape(withName[0], urlBase);
}

/**
 * One photograph, but only if it belongs to the case named in the URL.
 *
 * The case id is part of the lookup rather than checked afterwards. A fleet
 * portal that has already established which cases this organisation may see
 * then cannot be walked sideways into another one's photographs by swapping
 * the photo id.
 */
async function get({ caseId, photoId }, db = pgDb) {
  const { rows } = await db.query(
    'SELECT * FROM theft_case_photos WHERE id = $1 AND case_id = $2',
    [Number(photoId), Number(caseId)]);
  return rows[0] || null;
}

/** Where a stored photograph can be read from, whichever backend holds it. */
function diskPath(photo) {
  return path.isAbsolute(photo.file_path) ? photo.file_path : path.join(PHOTO_DIR, photo.file_path);
}

/**
 * Stream a photograph to a response. Returns false when the bytes are gone, so
 * the caller can 404 rather than hang a half-written response.
 */
async function sendTo(res, photo) {
  const onDisk = diskPath(photo);
  if (fs.existsSync(onDisk)) { res.sendFile(onDisk); return true; }
  if (storageService.isConfigured() && !path.isAbsolute(photo.file_path)) {
    const obj = await storageService.getObjectStream(`${OBJECT_PREFIX}/${photo.file_path}`);
    if (obj) {
      if (obj.contentType) res.type(obj.contentType);
      if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);
      obj.stream.pipe(res);
      return true;
    }
  }
  return false;
}

/** Delete the row, then the bytes. Best-effort on the bytes, by design. */
async function remove(photo, db = pgDb) {
  await db.query('DELETE FROM theft_case_photos WHERE id = $1', [photo.id]);
  try { fs.unlinkSync(diskPath(photo)); } catch { /* best effort */ }
  if (storageService.isConfigured() && !path.isAbsolute(photo.file_path)) {
    try { await storageService.deleteObject(`${OBJECT_PREFIX}/${photo.file_path}`); } catch { /* best effort */ }
  }
}

module.exports = {
  upload, record, forCase, countForCase, get, remove, sendTo, discard,
  STAGES, MAX_PER_CASE, MAX_BYTES, PHOTO_DIR, PRIVATE_BASE, OBJECT_PREFIX,
};
