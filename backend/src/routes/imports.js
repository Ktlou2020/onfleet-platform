const express = require('express');
const multer = require('multer');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { previewImportCsv, applyCsvMapping } = require('../services/csvPreview');
const {
  importRidersCsv,
  importBikesCsv,
  importAgreementsCsv,
  importPaymentsCsv,
  importLegacyBundle,
  importUserTagsCsv
} = require('../services/csvImports');

const SPECIAL_AUDIENCE_TAG = 'password-reset-batch-2026-05';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.use(authRequired, adminOnly);

function ensureFile(req, res) {
  if (!req.file) {
    res.status(400).json({ error: 'CSV file is required' });
    return false;
  }
  return true;
}

function getMappedBuffer(req) {
  if (!req.body?.mappings) return req.file.buffer;
  const mapping = JSON.parse(req.body.mappings);
  return applyCsvMapping(req.file.buffer, req.body.import_type || req.path.split('/').pop(), mapping);
}

router.post('/preview', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const importType = String(req.body.import_type || '').trim();
  if (!importType) return res.status(400).json({ error: 'import_type is required' });
  try {
    const preview = previewImportCsv(req.file.buffer, importType);
    res.json(preview);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/riders', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importRidersCsv(getMappedBuffer(req));
  logAudit(req.user.id, 'import.riders_csv', 'users', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null }, req.ip);
  res.json(summary);
});

router.post('/bikes', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importBikesCsv(getMappedBuffer(req));
  logAudit(req.user.id, 'import.bikes_csv', 'bikes', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null }, req.ip);
  res.json(summary);
});

router.post('/agreements', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importAgreementsCsv(getMappedBuffer(req));
  logAudit(req.user.id, 'import.agreements_csv', 'agreements', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null }, req.ip);
  res.json(summary);
});

router.post('/payments', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importPaymentsCsv(getMappedBuffer(req), req.user.id);
  logAudit(req.user.id, 'import.payments_csv', 'payments', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null }, req.ip);
  res.json(summary);
});

router.post('/legacy-bundle', upload.fields([
  { name: 'riders_file', maxCount: 1 },
  { name: 'bikes_file', maxCount: 1 },
  { name: 'payments_file', maxCount: 1 }
]), (req, res) => {
  const ridersFile = req.files?.riders_file?.[0] || null;
  const bikesFile = req.files?.bikes_file?.[0] || null;
  const paymentsFile = req.files?.payments_file?.[0] || null;
  if (!ridersFile && !bikesFile && !paymentsFile) {
    return res.status(400).json({ error: 'Provide at least one CSV file' });
  }
  const summary = importLegacyBundle({ ridersFile, bikesFile, paymentsFile, recordedBy: req.user.id });
  logAudit(req.user.id, 'import.legacy_bundle', 'imports', null, summary, req.ip);
  res.json(summary);
});

router.post('/special-tag-users', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importUserTagsCsv(getMappedBuffer(req), { tag: SPECIAL_AUDIENCE_TAG });
  logAudit(req.user.id, 'import.special_tag_users_csv', 'users', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null }, req.ip);
  res.json(summary);
});

module.exports = router;
