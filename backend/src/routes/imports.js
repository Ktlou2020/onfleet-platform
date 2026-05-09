const express = require('express');
const multer = require('multer');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
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

router.post('/riders', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importRidersCsv(req.file.buffer);
  logAudit(req.user.id, 'import.riders_csv', 'users', null, summary, req.ip);
  res.json(summary);
});

router.post('/bikes', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importBikesCsv(req.file.buffer);
  logAudit(req.user.id, 'import.bikes_csv', 'bikes', null, summary, req.ip);
  res.json(summary);
});

router.post('/agreements', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importAgreementsCsv(req.file.buffer);
  logAudit(req.user.id, 'import.agreements_csv', 'agreements', null, summary, req.ip);
  res.json(summary);
});

router.post('/payments', upload.single('file'), (req, res) => {
  if (!ensureFile(req, res)) return;
  const summary = importPaymentsCsv(req.file.buffer, req.user.id);
  logAudit(req.user.id, 'import.payments_csv', 'payments', null, summary, req.ip);
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
  const summary = importUserTagsCsv(req.file.buffer, { tag: SPECIAL_AUDIENCE_TAG });
  logAudit(req.user.id, 'import.special_tag_users_csv', 'users', null, summary, req.ip);
  res.json(summary);
});

module.exports = router;
