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
const asyncRouter = require('../utils/asyncRouter');
const { hybridStorage } = require('../utils/hybridStorage');
const storageService = require('../services/storageService');

const router = asyncRouter(express.Router());
const { kyc: uploadDir } = require('../uploadPaths');

const upload = multer({
  storage: hybridStorage(uploadDir, 'kyc', (req, file) =>
    `${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`),
  limits: { fileSize: 8 * 1024 * 1024 }
});

router.post('/upload', authRequired, upload.single('file'), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { doc_type } = req.body;
  if (!['id_document','proof_of_address','drivers_license','bank_statement','selfie','other'].includes(doc_type))
    return res.status(400).json({ error: 'Invalid doc_type' });

  const { rows } = await pgDb.query(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name)
                           VALUES ($1,$2,$3,$4) RETURNING id`, [req.user.id, doc_type, req.file.filename, req.file.originalname]);
  const id = rows[0].id;
  await logAudit(req.user.id, 'kyc.upload', 'kyc_documents', id, { doc_type });
  res.json({ id });
});

router.get('/mine', authRequired, async (req, res) => {
  const { rows: docs } = await pgDb.query(`SELECT id, doc_type, original_name, status, rejection_reason, uploaded_at
                           FROM kyc_documents WHERE user_id = $1 ORDER BY uploaded_at DESC`, [req.user.id]);
  res.json({ documents: docs });
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

  // Resolve to an absolute path and verify it stays within uploadDir
  const normalized = path.normalize(doc.file_path || '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    return res.status(400).end();
  }
  const absolute = path.join(uploadDir, normalized);
  if (!absolute.startsWith(uploadDir + path.sep) && absolute !== uploadDir) {
    return res.status(400).end();
  }
  if (fs.existsSync(absolute)) return res.sendFile(absolute);

  if (storageService.isConfigured()) {
    const obj = await storageService.getObjectStream(`kyc/${normalized}`);
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
