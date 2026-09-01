const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
// Postgres version — see helpersPg.js's header comment for why it's a
// separate file from the SQLite original (other, not-yet-migrated routes
// still depend on that).
const { logAudit } = require('../utils/helpersPg');
const { requireValidMime } = require('../utils/validateUpload');
const { convertHeicUploads } = require('../utils/heicToJpeg');
const asyncRouter = require('../utils/asyncRouter');
const { hybridStorage } = require('../utils/hybridStorage');
const storageService = require('../services/storageService');

const router = asyncRouter(express.Router());
const UPLOAD_DIRS = require('../uploadPaths');
const { kyc: uploadDir } = UPLOAD_DIRS;

const upload = multer({
  storage: hybridStorage(uploadDir, 'kyc', (req, file) =>
    `${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`),
  // 15 MB, matching the most generous limit already used elsewhere in the
  // codebase. These are photographs of ID documents taken on phones, which
  // routinely exceed the previous 8 MB — production already holds a 5 MB one.
  limits: { fileSize: 15 * 1024 * 1024 }
});

router.post('/upload', authRequired, upload.single('file'), convertHeicUploads(), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { doc_type } = req.body;
  if (!['id_document','proof_of_address','drivers_license','bank_statement','selfie','other'].includes(doc_type))
    return res.status(400).json({ error: 'Invalid doc_type' });

  // Admins can file a document on a rider's behalf — riders regularly bring
  // paperwork to a hub or email it in, and before this the only way to get it
  // onto their record was to ask them to upload it themselves. Everyone else is
  // strictly self-only: an ordinary user passing user_id is ignored, not obeyed.
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
  const requestedUserId = Number(req.body.user_id);
  let ownerId = req.user.id;

  if (isAdmin && Number.isFinite(requestedUserId) && requestedUserId !== req.user.id) {
    const { rows: target } = await pgDb.query(
      `SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL`, [requestedUserId]);
    if (!target[0]) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Rider not found' });
    }
    if (target[0].role !== 'rider') {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Documents can only be filed against a rider account' });
    }
    ownerId = target[0].id;
  }

  const { rows } = await pgDb.query(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name)
                           VALUES ($1,$2,$3,$4) RETURNING id`, [ownerId, doc_type, req.file.filename, req.file.originalname]);
  const id = rows[0].id;
  // on_behalf_of records that this wasn't the rider's own upload — the row
  // itself only carries the owner, so without this the distinction is lost.
  await logAudit(req.user.id, 'kyc.upload', 'kyc_documents', id,
    { doc_type, ...(ownerId !== req.user.id ? { on_behalf_of: ownerId } : {}) });
  res.json({ id, user_id: ownerId });
});

router.get('/mine', authRequired, async (req, res) => {
  const { rows: docs } = await pgDb.query(`SELECT id, doc_type, original_name, status, rejection_reason, uploaded_at
                           FROM kyc_documents WHERE user_id = $1 ORDER BY uploaded_at DESC`, [req.user.id]);
  res.json({ documents: docs });
});

// Everything on file for one rider, for the admin filing documents on their
// behalf — otherwise there's no way to see what's already there and duplicates
// get uploaded. Reuses the same access rule as /file/:id and is audited the
// same way, since this is an admin reading a rider's personal paperwork.
router.get('/user/:userId', authRequired, adminOnly, async (req, res) => {
  const { rows: user } = await pgDb.query(
    `SELECT id, full_name, email FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.params.userId]);
  if (!user[0]) return res.status(404).json({ error: 'Rider not found' });

  const { rows: docs } = await pgDb.query(
    `SELECT id, doc_type, original_name, status, rejection_reason, uploaded_at
       FROM kyc_documents WHERE user_id = $1 ORDER BY uploaded_at DESC`, [req.params.userId]);
  await logAudit(req.user.id, 'kyc.list_for_user', 'users', user[0].id, { count: docs.length }, req.ip);
  res.json({ rider: user[0], documents: docs });
});

router.get('/file/:id', authRequired, async (req, res) => {
  const { rows } = await pgDb.query('SELECT * FROM kyc_documents WHERE id = $1', [req.params.id]);
  const doc = rows[0];
  if (!doc) return res.status(404).end();
  if (doc.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role))
    return res.status(403).end();
  if (doc.user_id !== req.user.id) {
    await logAudit(req.user.id, 'kyc.view', 'kyc_documents', doc.id, { subject_user_id: doc.user_id, doc_type: doc.doc_type }, req.ip);
  }

  // file_path comes in two shapes. Documents uploaded through this route store
  // a bare filename that lives under uploads/kyc. Everything created by the old
  // signup flow — which is all 8,639 existing rows — stored a full web path like
  // /uploads/applications/x.jpg, with the file physically in that other folder.
  // Treating the second shape as a filename made path.isAbsolute reject it, so
  // no existing KYC document could be viewed at all. Resolve both, and confine
  // each to its own root so a crafted path still can't escape.
  const raw = String(doc.file_path || '');
  if (!raw || raw.includes('..')) return res.status(400).end();

  const webPath = raw.startsWith('/uploads/');
  const root = webPath ? UPLOAD_DIRS.base : uploadDir;
  const relative = path.normalize(webPath ? raw.slice('/uploads/'.length) : raw);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return res.status(400).end();
  }
  const absolute = path.join(root, relative);
  if (!absolute.startsWith(root + path.sep)) {
    return res.status(400).end();
  }
  if (fs.existsSync(absolute)) return res.sendFile(absolute);

  if (storageService.isConfigured()) {
    const obj = await storageService.getObjectStream(webPath ? relative : `kyc/${relative}`);
    if (obj) {
      if (obj.contentType) res.type(obj.contentType);
      if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);
      return obj.stream.pipe(res);
    }
  }
  return res.status(404).end();
});

// Admin
router.get('/all', authRequired, adminOnly, async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows: docs } = await pgDb.query(`SELECT k.*, u.full_name, u.email FROM kyc_documents k
                           JOIN users u ON u.id = k.user_id
                           WHERE k.status = $1 ORDER BY k.uploaded_at DESC`, [status]);
  await logAudit(req.user.id, 'kyc.list', 'kyc_documents', null, { status, count: docs.length }, req.ip);
  res.json({ documents: docs });
});

router.post('/:id/review', authRequired, adminOnly, async (req, res) => {
  const { status, rejection_reason } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rowCount } = await pgDb.query(`UPDATE kyc_documents SET status = $1, rejection_reason = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = $4`, [status, rejection_reason || null, req.user.id, req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: 'Document not found' });
  await logAudit(req.user.id, 'kyc.review', 'kyc_documents', +req.params.id, { status });
  res.json({ ok: true });
});

module.exports = router;
