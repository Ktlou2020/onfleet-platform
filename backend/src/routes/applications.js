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
const { applications: uploadDir } = require('../uploadPaths');

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
    // Allow PDF, images, and common document formats
    const blocked = ['application/x-msdownload', 'application/x-sh', 'text/html'];
    cb(blocked.includes(file.mimetype) ? new Error('File type not allowed') : null, !blocked.includes(file.mimetype));
  }
});

function parseMoneyAmount(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return +amount.toFixed(2);
}

function isPayslipImageMime(mimeType) {
  return ['image/jpeg', 'image/jpg'].includes(String(mimeType || '').toLowerCase());
}

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
      null,
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

function refreshApplicationFinancials(applicationId) {
  const { total, average } = getPayslipSummary(applicationId);
  db.prepare(`UPDATE applications SET total_paid_last_3 = ?, average_weekly_earnings = ? WHERE id = ?`)
    .run(total, average, applicationId);
  return { total, average };
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

function adminVisibleApplicationClause(aAlias = 'a', uAlias = 'u', bAlias = 'b') {
  return `${uAlias}.organization_id IS NULL AND (${bAlias}.id IS NULL OR ${bAlias}.organization_id IS NULL)`;
}

function getApplicationWithRelations(applicationId, options = {}) {
  const scopeClause = options.adminVisible ? ` AND ${adminVisibleApplicationClause('a', 'u', 'b')}` : '';
  return db.prepare(`SELECT a.*, u.full_name, u.email, u.phone, u.id_number, u.address, u.city, u.province, u.avatar_url,
      b.make, b.model, b.registration, b.image_url
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.id = ?${scopeClause}`).get(applicationId);
}

async function approveApplication({ applicationId, bikeId, weeklyAmount, totalWeeks, startDate, reviewerId }) {
  if (!bikeId || !weeklyAmount || !startDate) {
    throw new Error('bike_id, weekly_amount, start_date required');
  }

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) throw new Error('Application not found');
  if (!['submitted', 'under_review'].includes(app.status)) {
    throw new Error('Only submitted or under review applications can be approved');
  }

  const rider = db.prepare('SELECT * FROM users WHERE id = ?').get(app.user_id);
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(bikeId);
  if (!bike) throw new Error('Bike not found');
  if (bike.status !== 'ready_to_go') throw new Error('Bike must be Ready to go before allocation');

  const weeks = Number(totalWeeks || bike.total_weeks || 78);
  const weekly = Number(weeklyAmount);
  if (!weekly || weekly <= 0) throw new Error('Weekly amount must be greater than zero');

  const total = +(weekly * weeks).toFixed(2);
  const endDate = addDays(startDate, weeks * 7);
  const agreementNo = generateAgreementNo();

  const agreementId = db.transaction(() => {
    db.prepare(`UPDATE applications
      SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
      WHERE id = ?`).run(reviewerId, applicationId);
    db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
    const info = db.prepare(`INSERT INTO agreements
      (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount,
       start_date, end_date, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`).run(
        agreementNo, app.user_id, bikeId, app.id, weekly, weeks, total, startDate, endDate, reviewerId
      );
    buildPaymentSchedule(info.lastInsertRowid, weekly, weeks, startDate);
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
      reviewerId
    );

  await sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_approved',
    title: 'OnFleet application approved',
    message: `Hi ${rider.full_name.split(' ')[0]}, your application has been approved. Your bike has been allocated and your agreement ${agreementNo} is now ready for review and signature on the platform.`
  });

  logAudit(reviewerId, 'application.approve', 'applications', Number(applicationId), { agreementId, bikeId });
  return { ok: true, agreement_id: agreementId, agreement_no: agreementNo, contract_file_path: contractPath, bike_id: Number(bikeId) };
}

async function rejectApplication({ applicationId, reviewerId, reason }) {
  const app = db.prepare(`SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(applicationId);
  if (!app) throw new Error('Application not found');
  if (!['submitted', 'under_review'].includes(app.status)) {
    throw new Error('Only submitted or under review applications can be declined');
  }

  db.prepare(`UPDATE applications SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(reason || null, reviewerId, applicationId);
  await sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_rejected',
    title: 'OnFleet application update',
    message: `Hi ${app.full_name.split(' ')[0]}, your application has been declined. ${reason || 'Please contact OnFleet support for more information.'}`
  });
  logAudit(reviewerId, 'application.reject', 'applications', Number(applicationId), { reason: reason || null });
  return { ok: true };
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
    const isPdf = req.file.mimetype === 'application/pdf';
    const manualPayslipAmount = parseMoneyAmount(req.body.manual_payslip_amount);
    if (isPdf) {
      insights = await extractPayslipInsights(req.file.path, req.file.mimetype);
    }
    if (!insights.extracted_amount && manualPayslipAmount) {
      insights = {
        ...insights,
        extracted_amount: manualPayslipAmount,
        extracted_text: isPdf ? 'Manual amount entered for PDF payslip' : 'Manual amount entered (non-PDF payslip)'
      };
    }
    if (!insights.extracted_amount) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: isPdf ? 'Could not read amount from PDF — enter the Rand amount manually.' : 'Enter the monthly Rand amount for this payslip.' });
    }
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
  const apps = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url,
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
  const where = [`${adminVisibleApplicationClause('a', 'u', 'b')}`];
  const values = [];
  if (status) {
    where.push('a.status = ?');
    values.push(status);
  }
  const sql = `SELECT a.*, u.full_name, u.email, u.phone, u.avatar_url, b.make, b.model, b.registration, b.image_url,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.submitted_at DESC`;
  const apps = db.prepare(sql).all(...values);
  res.json({ applications: apps });
});

router.post('/bulk-review', authRequired, adminOnly, async (req, res) => {
  const { action, application_ids, approvals, reason } = req.body || {};
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  if (action === 'approve') {
    if (!Array.isArray(approvals) || !approvals.length) {
      return res.status(400).json({ error: 'approvals are required' });
    }

    const results = [];
    const errors = [];
    for (const approval of approvals) {
      try {
        const result = await approveApplication({
          applicationId: approval.application_id,
          bikeId: approval.bike_id,
          weeklyAmount: approval.weekly_amount,
          totalWeeks: approval.total_weeks,
          startDate: approval.start_date,
          reviewerId: req.user.id
        });
        results.push({ application_id: Number(approval.application_id), ...result });
      } catch (error) {
        errors.push({ application_id: Number(approval.application_id), error: error.message });
      }
    }

    return res.json({ ok: errors.length === 0, action, processed: results.length, failed: errors.length, results, errors });
  }

  const ids = Array.isArray(application_ids) ? application_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'application_ids are required' });

  const results = [];
  const errors = [];
  for (const applicationId of ids) {
    try {
      await rejectApplication({ applicationId, reviewerId: req.user.id, reason });
      results.push({ application_id: Number(applicationId), ok: true });
    } catch (error) {
      errors.push({ application_id: Number(applicationId), error: error.message });
    }
  }

  res.json({ ok: errors.length === 0, action, processed: results.length, failed: errors.length, results, errors });
});

router.patch('/:id/admin-update', authRequired, adminOnly, (req, res) => {
  const applicationId = Number(req.params.id);
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return res.status(400).json({ error: 'Invalid application id' });
  }

  const current = getApplicationWithRelations(applicationId, { adminVisible: true });
  if (!current) return res.status(404).json({ error: 'Application not found' });

  const userUpdates = [];
  const userValues = [];
  const applicationUpdates = [];
  const applicationValues = [];

  if (req.body.full_name !== undefined) {
    const fullName = String(req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required' });
    userUpdates.push('full_name = ?');
    userValues.push(fullName);
  }

  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL').get(email, current.user_id);
    if (conflict) return res.status(409).json({ error: 'Email already exists for another user' });
    userUpdates.push('email = ?');
    userValues.push(email);
  }

  for (const field of ['phone', 'id_number', 'address', 'city', 'province']) {
    if (req.body[field] !== undefined) {
      userUpdates.push(`${field} = ?`);
      userValues.push(String(req.body[field] || '').trim() || null);
    }
  }

  if (req.body.preferred_bike_id !== undefined) {
    const bikeId = req.body.preferred_bike_id ? Number(req.body.preferred_bike_id) : null;
    if (bikeId !== null && !Number.isInteger(bikeId)) return res.status(400).json({ error: 'Invalid preferred bike' });
    if (bikeId !== null) {
      const bike = db.prepare('SELECT id FROM bikes WHERE id = ?').get(bikeId);
      if (!bike) return res.status(404).json({ error: 'Preferred bike not found' });
    }
    applicationUpdates.push('preferred_bike_id = ?');
    applicationValues.push(bikeId);
  }

  if (req.body.delivery_platforms !== undefined) {
    const platforms = Array.isArray(req.body.delivery_platforms)
      ? req.body.delivery_platforms.filter(Boolean)
      : String(req.body.delivery_platforms || '').split(',').map((item) => item.trim()).filter(Boolean);
    applicationUpdates.push('delivery_platforms = ?');
    applicationValues.push(platforms.join(','));
  }

  if (req.body.has_riding_experience !== undefined) {
    applicationUpdates.push('has_riding_experience = ?');
    applicationValues.push(req.body.has_riding_experience ? 1 : 0);
  }

  if (req.body.years_riding !== undefined) {
    const years = req.body.years_riding === '' || req.body.years_riding === null ? null : Number(req.body.years_riding);
    if (years !== null && (!Number.isFinite(years) || years < 0)) return res.status(400).json({ error: 'Years riding must be zero or greater' });
    applicationUpdates.push('years_riding = ?');
    applicationValues.push(years);
  }

  if (req.body.has_drivers_license !== undefined) {
    applicationUpdates.push('has_drivers_license = ?');
    applicationValues.push(req.body.has_drivers_license ? 1 : 0);
  }

  if (req.body.payout_preference !== undefined) {
    const payout = String(req.body.payout_preference || '').trim();
    if (!['eft', 'ewallet'].includes(payout)) return res.status(400).json({ error: 'Invalid payout preference' });
    applicationUpdates.push('payout_preference = ?');
    applicationValues.push(payout);
  }

  for (const field of ['bank_name', 'account_holder', 'account_number', 'branch_code', 'ewallet_number']) {
    if (req.body[field] !== undefined) {
      applicationUpdates.push(`${field} = ?`);
      applicationValues.push(String(req.body[field] || '').trim() || null);
    }
  }

  if (!userUpdates.length && !applicationUpdates.length) return res.json({ ok: true });

  db.transaction(() => {
    if (userUpdates.length) {
      db.prepare(`UPDATE users SET ${userUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...userValues, current.user_id);
    }
    if (applicationUpdates.length) {
      db.prepare(`UPDATE applications SET ${applicationUpdates.join(', ')}, reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP) WHERE id = ?`).run(...applicationValues, applicationId);
    }
  })();

  logAudit(req.user.id, 'application.admin_update', 'applications', applicationId, {
    user_fields_updated: userUpdates.length,
    application_fields_updated: applicationUpdates.length
  });

  res.json({ ok: true, application: getApplicationWithRelations(applicationId) });
});

router.patch('/:id/documents/:docId', authRequired, adminOnly, async (req, res) => {
  const applicationId = Number(req.params.id);
  const documentId = Number(req.params.docId);
  if (!Number.isInteger(applicationId) || applicationId <= 0 || !Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({ error: 'Invalid application document id' });
  }

  const app = db.prepare(`SELECT a.id, a.status, a.auto_decision
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.id = ? AND ${adminVisibleApplicationClause('a', 'u', 'b')}`).get(applicationId);
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const existing = db.prepare('SELECT * FROM application_documents WHERE id = ? AND application_id = ?').get(documentId, applicationId);
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const updates = [];
  const values = [];

  if (req.body.extracted_amount !== undefined) {
    const amount = req.body.extracted_amount === '' || req.body.extracted_amount === null ? null : Number(req.body.extracted_amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ error: 'Extracted amount must be zero or greater' });
    }
    updates.push('extracted_amount = ?');
    values.push(amount);
  }

  if (req.body.status !== undefined) {
    const status = String(req.body.status || '').trim();
    if (!['uploaded', 'verified', 'rejected', 'signed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid document status' });
    }
    updates.push('status = ?');
    values.push(status);
  }

  if (!updates.length) return res.json({ ok: true, document: existing });

  db.prepare(`UPDATE application_documents SET ${updates.join(', ')} WHERE id = ?`).run(...values, documentId);

  let decision = null;
  if (existing.doc_type === 'payslip') {
    if (['submitted', 'under_review', 'rejected'].includes(app.status)) decision = await recalcApplicationDecision(applicationId);
    else decision = { ...refreshApplicationFinancials(applicationId), decision: app.auto_decision || null };
  }

  logAudit(req.user.id, 'application.document_update', 'application_documents', documentId, {
    application_id: applicationId,
    doc_type: existing.doc_type
  });

  const document = db.prepare('SELECT id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_at FROM application_documents WHERE id = ?').get(documentId);
  res.json({ ok: true, document, decision });
});

router.get('/:id', authRequired, (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const app = getApplicationWithRelations(req.params.id, { adminVisible: isAdminPortalUser });
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (app.user_id !== req.user.id && !isAdminPortalUser) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const documents = hydrateDocuments(app.id);
  const agreement = db.prepare(`SELECT id, agreement_no, contract_file_path, signed_contract_path, signed_at, status
    FROM agreements WHERE application_id = ?`).get(app.id);
  res.json({ application: app, documents, agreement });
});

router.post('/:id/approve', authRequired, adminOnly, async (req, res) => {
  try {
    const visible = getApplicationWithRelations(req.params.id, { adminVisible: true });
    if (!visible) return res.status(404).json({ error: 'Application not found' });
    const result = await approveApplication({
      applicationId: req.params.id,
      bikeId: req.body.bike_id,
      weeklyAmount: req.body.weekly_amount,
      totalWeeks: req.body.total_weeks,
      startDate: req.body.start_date,
      reviewerId: req.user.id
    });
    res.json(result);
  } catch (error) {
    res.status(error.message === 'Application not found' || error.message === 'Bike not found' ? 404 : 400).json({ error: error.message });
  }
});

router.post('/:id/reject', authRequired, adminOnly, async (req, res) => {
  try {
    const visible = getApplicationWithRelations(req.params.id, { adminVisible: true });
    if (!visible) return res.status(404).json({ error: 'Application not found' });
    const result = await rejectApplication({ applicationId: req.params.id, reviewerId: req.user.id, reason: req.body.reason });
    res.json(result);
  } catch (error) {
    res.status(error.message === 'Application not found' ? 404 : 400).json({ error: error.message });
  }
});

module.exports = router;
