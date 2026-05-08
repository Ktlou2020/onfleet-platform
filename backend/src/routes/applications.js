const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpers');
const { sendNotification } = require('../services/notifier');
const { extractPayslipInsights } = require('../services/documentInsights');
const { writeContractSnapshot } = require('../services/contracts');

const router = express.Router();
const uploadDir = path.join(__dirname, '../../uploads/applications');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF, JPG, JPEG, and PNG files are allowed'), ok);
  }
});

function createApplication(payload, actor, userId) {
  const totalPaid = Number(payload.total_paid_last_3 || 0);
  const averageWeekly = Number(payload.average_weekly_earnings || 0);
  const info = db.prepare(`INSERT INTO applications
    (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience,
     years_riding, has_drivers_license, references_json, payout_preference, bank_name,
     account_holder, account_number, branch_code, ewallet_number, total_paid_last_3,
     average_weekly_earnings, auto_decision, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      userId,
      payload.preferred_bike_id || null,
      payload.monthly_income || null,
      (payload.delivery_platforms || []).join(','),
      payload.has_riding_experience ? 1 : 0,
      payload.years_riding || null,
      payload.has_drivers_license ? 1 : 0,
      JSON.stringify(payload.references || []),
      payload.payout_preference || null,
      payload.bank_name || null,
      payload.account_holder || null,
      payload.account_number || null,
      payload.branch_code || null,
      payload.ewallet_number || null,
      totalPaid,
      averageWeekly,
      payload.auto_decision || null,
      payload.status || 'submitted'
    );
  logAudit(actor.id, actor.id === userId ? 'application.submit' : 'application.create_admin', 'applications', info.lastInsertRowid);
  return info.lastInsertRowid;
}

function getPayslipSummary(applicationId) {
  const payslips = db.prepare(`SELECT * FROM application_documents
    WHERE application_id = ? AND doc_type = 'payslip' AND extracted_amount IS NOT NULL
    ORDER BY uploaded_at DESC LIMIT 3`).all(applicationId);
  const total = payslips.reduce((sum, row) => sum + Number(row.extracted_amount || 0), 0);
  const average = payslips.length ? +(total / payslips.length).toFixed(2) : 0;
  return { payslips, total: +total.toFixed(2), average };
}

async function recalcApplicationDecision(applicationId) {
  const application = db.prepare(`SELECT a.*, u.full_name, u.email
    FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(applicationId);
  if (!application) return null;

  const { payslips, total, average } = getPayslipSummary(applicationId);
  db.prepare(`UPDATE applications SET total_paid_last_3 = ?, average_weekly_earnings = ? WHERE id = ?`)
    .run(total, average, applicationId);

  if (payslips.length < 3) {
    return { total, average, decision: 'insufficient_documents' };
  }

  if (average < 1000) {
    const retryAfter = addDays(new Date().toISOString().slice(0, 10), 14);
    db.prepare(`UPDATE applications
      SET status = 'rejected', auto_decision = 'auto_declined', rejection_reason = ?, retry_after_date = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
        `Average weekly earnings of R${average.toFixed(2)} are below the R1000 minimum. Please reapply after ${retryAfter}.`,
        retryAfter,
        applicationId
      );
    await sendNotification({
      userId: application.user_id,
      channel: 'email',
      type: 'application_auto_declined',
      title: 'OnFleet application update',
      message: `Hi ${application.full_name.split(' ')[0]}, your application has been auto-declined because the latest 3 payslips show average weekly earnings of R${average.toFixed(2)}, below the minimum R1000 threshold. You may retry after ${retryAfter}.`
    });
    return { total, average, decision: 'auto_declined', retry_after_date: retryAfter };
  }

  db.prepare(`UPDATE applications
    SET status = 'under_review', auto_decision = 'pre_approved', rejection_reason = NULL, retry_after_date = NULL
    WHERE id = ?`).run(applicationId);
  await sendNotification({
    userId: application.user_id,
    channel: 'email',
    type: 'application_preapproved',
    title: 'OnFleet application pre-approved',
    message: `Hi ${application.full_name.split(' ')[0]}, great news — your application has been pre-approved based on average weekly earnings of R${average.toFixed(2)}. Our team will now allocate a bike and send your electronic contract.`
  });
  return { total, average, decision: 'pre_approved' };
}

function hydrateDocuments(applicationId) {
  return db.prepare(`SELECT id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_at
    FROM application_documents WHERE application_id = ? ORDER BY uploaded_at DESC`).all(applicationId);
}

router.post('/', authRequired, async (req, res) => {
  const lastRejected = db.prepare(`SELECT retry_after_date FROM applications
    WHERE user_id = ? AND status = 'rejected' AND retry_after_date IS NOT NULL
    ORDER BY submitted_at DESC LIMIT 1`).get(req.user.id);
  if (lastRejected?.retry_after_date && lastRejected.retry_after_date > new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: `You can reapply after ${lastRejected.retry_after_date}` });
  }

  const id = createApplication(req.body, req.user, req.user.id);
  res.json({ id });
});

router.post('/admin-create', authRequired, adminOnly, (req, res) => {
  const rider = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'rider' AND deleted_at IS NULL`).get(req.body.user_id);
  if (!rider) return res.status(404).json({ error: 'Rider not found' });
  const id = createApplication(req.body, req.user, rider.id);
  res.json({ id });
});

router.post('/:id/documents', authRequired, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { doc_type } = req.body;
  if (!['id_document', 'drivers_license', 'payslip', 'other'].includes(doc_type)) {
    return res.status(400).json({ error: 'Invalid doc_type' });
  }

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let insights = { extracted_amount: null, extracted_text: null };
  if (doc_type === 'payslip') {
    insights = await extractPayslipInsights(req.file.path, req.file.mimetype);
  }

  const publicFile = `/uploads/applications/${req.file.filename}`;
  const info = db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      app.id,
      app.user_id,
      doc_type,
      publicFile,
      req.file.originalname,
      req.file.mimetype,
      insights.extracted_amount || null,
      insights.extracted_text || null,
      req.user.id
    );

  const decision = doc_type === 'payslip' ? await recalcApplicationDecision(app.id) : null;
  logAudit(req.user.id, 'application.document_upload', 'application_documents', info.lastInsertRowid, { doc_type, application_id: app.id });
  res.json({ id: info.lastInsertRowid, extracted_amount: insights.extracted_amount || null, decision });
});

router.get('/mine', authRequired, (req, res) => {
  const apps = db.prepare(`SELECT a.*, b.make, b.model,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.user_id = ?
    ORDER BY a.submitted_at DESC`).all(req.user.id).map((app) => ({
      ...app,
      documents: hydrateDocuments(app.id)
    }));
  res.json({ applications: apps });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const where = status ? 'WHERE a.status = ?' : '';
  const sql = `SELECT a.*, u.full_name, u.email, u.phone, b.make, b.model,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    ${where}
    ORDER BY a.submitted_at DESC`;
  const apps = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ applications: apps });
});

router.get('/:id', authRequired, (req, res) => {
  const app = db.prepare(`SELECT a.*, u.full_name, u.email, u.phone, u.id_number, u.address, u.city, u.province,
      b.make, b.model
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.id = ?`).get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (app.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const documents = hydrateDocuments(app.id);
  const agreement = db.prepare(`SELECT id, agreement_no, contract_file_path, signed_contract_path, signed_at, status
    FROM agreements WHERE application_id = ?`).get(app.id);
  res.json({ application: app, documents, agreement });
});

router.post('/:id/approve', authRequired, adminOnly, async (req, res) => {
  const { bike_id, weekly_amount, total_weeks, start_date } = req.body;
  if (!bike_id || !weekly_amount || !start_date) {
    return res.status(400).json({ error: 'bike_id, weekly_amount, start_date required' });
  }

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const rider = db.prepare('SELECT * FROM users WHERE id = ?').get(app.user_id);
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(bike_id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  if (bike.status !== 'available') return res.status(400).json({ error: 'Bike not available' });

  const weeks = Number(total_weeks || 78);
  const weekly = Number(weekly_amount);
  const total = +(weekly * weeks).toFixed(2);
  const endDate = addDays(start_date, weeks * 7);
  const agreementNo = generateAgreementNo();

  const agreementId = db.transaction(() => {
    db.prepare(`UPDATE applications
      SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
      WHERE id = ?`).run(req.user.id, req.params.id);
    db.prepare(`UPDATE bikes SET status = 'allocated' WHERE id = ?`).run(bike_id);
    const info = db.prepare(`INSERT INTO agreements
      (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount,
       start_date, end_date, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`).run(
        agreementNo, app.user_id, bike_id, app.id, weekly, weeks, total, start_date, endDate, req.user.id
      );
    buildPaymentSchedule(info.lastInsertRowid, weekly, weeks, start_date);
    return info.lastInsertRowid;
  })();

  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementId);
  const contractPath = writeContractSnapshot({ agreement, rider, bike, application: app, kind: 'unsigned' });
  db.prepare(`UPDATE agreements SET contract_file_path = ?, contract_pdf_path = ? WHERE id = ?`).run(contractPath, contractPath, agreementId);
  db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      app.id,
      app.user_id,
      'unsigned_contract',
      contractPath,
      `${agreementNo}-contract.html`,
      'text/html',
      'verified',
      req.user.id
    );

  await sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_approved',
    title: 'OnFleet application approved',
    message: `Hi ${rider.full_name.split(' ')[0]}, your application has been approved. Your bike has been allocated and your agreement ${agreementNo} is now ready for review and signature on the platform.`
  });

  logAudit(req.user.id, 'application.approve', 'applications', Number(req.params.id), { agreementId });
  res.json({ ok: true, agreement_id: agreementId, agreement_no: agreementNo, contract_file_path: contractPath });
});

router.post('/:id/reject', authRequired, adminOnly, async (req, res) => {
  const app = db.prepare(`SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  db.prepare(`UPDATE applications SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.body.reason || null, req.user.id, req.params.id);
  await sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_rejected',
    title: 'OnFleet application update',
    message: `Hi ${app.full_name.split(' ')[0]}, your application has been declined. ${req.body.reason || 'Please contact OnFleet support for more information.'}`
  });
  logAudit(req.user.id, 'application.reject', 'applications', Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
