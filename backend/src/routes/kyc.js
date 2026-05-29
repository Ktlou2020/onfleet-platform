const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');

const router = express.Router();
const { kyc: uploadDir } = require('../uploadPaths');

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

router.post('/upload', authRequired, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { doc_type } = req.body;
  if (!['id_document','proof_of_address','drivers_license','bank_statement','selfie','other'].includes(doc_type))
    return res.status(400).json({ error: 'Invalid doc_type' });

  const info = db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name)
                           VALUES (?,?,?,?)`).run(req.user.id, doc_type, req.file.filename, req.file.originalname);
  logAudit(req.user.id, 'kyc.upload', 'kyc_documents', info.lastInsertRowid, { doc_type });
  res.json({ id: info.lastInsertRowid });
});

router.get('/mine', authRequired, (req, res) => {
  const docs = db.prepare(`SELECT id, doc_type, original_name, status, rejection_reason, uploaded_at
                           FROM kyc_documents WHERE user_id = ? ORDER BY uploaded_at DESC`).all(req.user.id);
  res.json({ documents: docs });
});

router.get('/file/:id', authRequired, (req, res) => {
  const doc = db.prepare('SELECT * FROM kyc_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).end();
  if (doc.user_id !== req.user.id && !['admin','superadmin'].includes(req.user.role))
    return res.status(403).end();
  if (String(doc.file_path || '').startsWith('/uploads/')) {
    return res.sendFile(path.join(__dirname, '../../', doc.file_path.replace(/^\//, '')));
  }
  res.sendFile(path.join(uploadDir, doc.file_path));
});

// Admin
router.get('/all', authRequired, adminOnly, (req, res) => {
  const status = req.query.status || 'pending';
  const docs = db.prepare(`SELECT k.*, u.full_name, u.email FROM kyc_documents k
                           JOIN users u ON u.id = k.user_id
                           WHERE k.status = ? ORDER BY k.uploaded_at DESC`).all(status);
  res.json({ documents: docs });
});

router.post('/:id/review', authRequired, adminOnly, (req, res) => {
  const { status, rejection_reason } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE kyc_documents SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
              WHERE id = ?`).run(status, rejection_reason || null, req.user.id, req.params.id);
  logAudit(req.user.id, 'kyc.review', 'kyc_documents', +req.params.id, { status });
  res.json({ ok: true });
});

module.exports = router;
