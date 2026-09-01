const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
// Postgres versions — see each *Pg module's header comment for why it's a
// separate file from the SQLite original (other, not-yet-migrated routes
// still depend on those).
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpersPg');
const { sendNotification } = require('../services/notifierPg');
const { extractPayslipInsights } = require('../services/documentInsights');
const { writeContractSnapshot } = require('../services/contracts');
const { requireValidMime } = require('../utils/validateUpload');
const { convertHeicUploads } = require('../utils/heicToJpeg');
const asyncRouter = require('../utils/asyncRouter');
const { hybridStorage } = require('../utils/hybridStorage');

const router = asyncRouter(express.Router());
const { applications: uploadDir } = require('../uploadPaths');

const upload = multer({
  storage: hybridStorage(uploadDir, 'applications', (req, file) =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`),
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
  return ['image/heic', 'image/heif', 'image/jpeg', 'image/jpg'].includes(String(mimeType || '').toLowerCase());
}

async function createApplication(payload, actor, userId) {
  const totalPaid = Number(payload.total_paid_last_3 || 0);
  const averageWeekly = Number(payload.average_weekly_earnings || 0);
  const { rows } = await pgDb.query(`INSERT INTO applications
    (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience,
     years_riding, has_drivers_license, references_json, payout_preference, bank_name,
     account_holder, account_number, branch_code, ewallet_number, total_paid_last_3,
     average_weekly_earnings, auto_decision, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING id`, [
      userId,
      payload.preferred_bike_id || null,
      null,
      (payload.delivery_platforms || []).join(','),
      !!payload.has_riding_experience,
      payload.years_riding || null,
      !!payload.has_drivers_license,
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
    ]);
  const id = rows[0].id;
  await logAudit(actor.id, actor.id === userId ? 'application.submit' : 'application.create_admin', 'applications', id);
  return id;
}

async function getPayslipSummary(applicationId) {
  const { rows: payslips } = await pgDb.query(`SELECT * FROM application_documents
    WHERE application_id = $1 AND doc_type = 'payslip' AND extracted_amount IS NOT NULL
    ORDER BY uploaded_at DESC LIMIT 3`, [applicationId]);
  const total = payslips.reduce((sum, row) => sum + Number(row.extracted_amount || 0), 0);
  const average = payslips.length ? +(total / payslips.length).toFixed(2) : 0;
  return { payslips, total: +total.toFixed(2), average };
}

async function refreshApplicationFinancials(applicationId) {
  const { total, average } = await getPayslipSummary(applicationId);
  await pgDb.query(`UPDATE applications SET total_paid_last_3 = $1, average_weekly_earnings = $2 WHERE id = $3`,
    [total, average, applicationId]);
  return { total, average };
}

async function recalcApplicationDecision(applicationId) {
  const { rows: appRows } = await pgDb.query(`SELECT a.*, u.full_name, u.email
    FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [applicationId]);
  const application = appRows[0];
  if (!application) return null;

  const { payslips, total, average } = await getPayslipSummary(applicationId);
  await pgDb.query(`UPDATE applications SET total_paid_last_3 = $1, average_weekly_earnings = $2 WHERE id = $3`,
    [total, average, applicationId]);

  if (payslips.length < 3) {
    return { total, average, decision: 'insufficient_documents' };
  }

  if (average < 1000) {
    const retryAfter = addDays(new Date().toISOString().slice(0, 10), 14);
    await pgDb.query(`UPDATE applications
      SET status = 'rejected', auto_decision = 'auto_declined', rejection_reason = $1, retry_after_date = $2, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = $3`, [
        `Average weekly earnings of R${average.toFixed(2)} are below the R1000 minimum. Please reapply after ${retryAfter}.`,
        retryAfter,
        applicationId
      ]);
    sendNotification({
      userId: application.user_id,
      channel: 'email',
      type: 'application_auto_declined',
      title: 'OnFleet application update',
      message: `Hi ${application.full_name.split(' ')[0]}, your application has been auto-declined because the latest 3 payslips show average weekly earnings of R${average.toFixed(2)}, below the minimum R1000 threshold. You may retry after ${retryAfter}.`
    }).catch((e) => console.error('[application] auto-decline email failed:', e.message));
    return { total, average, decision: 'auto_declined', retry_after_date: retryAfter };
  }

  await pgDb.query(`UPDATE applications
    SET status = 'under_review', auto_decision = 'pre_approved', rejection_reason = NULL, retry_after_date = NULL
    WHERE id = $1`, [applicationId]);
  sendNotification({
    userId: application.user_id,
    channel: 'email',
    type: 'application_preapproved',
    title: 'OnFleet application pre-approved',
    message: `Hi ${application.full_name.split(' ')[0]}, great news — your application has been pre-approved based on average weekly earnings of R${average.toFixed(2)}. Our team will now allocate a bike and send your electronic contract.`
  }).catch((e) => console.error('[application] pre-approval email failed:', e.message));
  return { total, average, decision: 'pre_approved' };
}

async function hydrateDocuments(applicationId) {
  const { rows } = await pgDb.query(`SELECT id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_at
    FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at DESC`, [applicationId]);
  return rows;
}

function adminVisibleApplicationClause(aAlias = 'a', uAlias = 'u', bAlias = 'b') {
  return `${uAlias}.organization_id IS NULL AND (${bAlias}.id IS NULL OR ${bAlias}.organization_id IS NULL)`;
}

async function getApplicationWithRelations(applicationId, options = {}) {
  const scopeClause = options.adminVisible ? ` AND ${adminVisibleApplicationClause('a', 'u', 'b')}` : '';
  const { rows } = await pgDb.query(`SELECT a.*, u.full_name, u.email, u.phone, u.id_number, u.address, u.city, u.province, u.avatar_url,
      b.make, b.model, b.registration, b.image_url
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.id = $1${scopeClause}`, [applicationId]);
  return rows[0];
}

async function approveApplication({ applicationId, bikeId, weeklyAmount, totalWeeks, startDate, reviewerId }) {
  if (!bikeId || !weeklyAmount || !startDate) {
    throw new Error('bike_id, weekly_amount, start_date required');
  }

  const { rows: appRows } = await pgDb.query('SELECT * FROM applications WHERE id = $1', [applicationId]);
  const app = appRows[0];
  if (!app) throw new Error('Application not found');
  if (!['submitted', 'under_review', 'rejected'].includes(app.status)) {
    throw new Error('Only submitted, under review, or rejected applications can be approved');
  }

  const { rows: riderRows } = await pgDb.query('SELECT * FROM users WHERE id = $1', [app.user_id]);
  const rider = riderRows[0];
  const { rows: bikeRows } = await pgDb.query('SELECT * FROM bikes WHERE id = $1', [bikeId]);
  const bike = bikeRows[0];
  if (!bike) throw new Error('Bike not found');
  if (bike.status !== 'ready_to_go') throw new Error('Bike must be Ready to go before allocation');

  const weeks = Number(totalWeeks || bike.total_weeks || 78);
  const weekly = Number(weeklyAmount);
  if (!weekly || weekly <= 0) throw new Error('Weekly amount must be greater than zero');

  const total = +(weekly * weeks).toFixed(2);
  const endDate = addDays(startDate, weeks * 7);
  const agreementNo = generateAgreementNo();

  const agreementId = await pgDb.withTransaction(async (client) => {
    await client.query(`UPDATE applications
      SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL
      WHERE id = $2`, [reviewerId, applicationId]);
    await client.query(`UPDATE bikes SET status = 'active' WHERE id = $1`, [bikeId]);
    const { rows: insertRows } = await client.query(`INSERT INTO agreements
      (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount,
       start_date, end_date, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, 'active', $10)
      RETURNING id`, [
        agreementNo, app.user_id, bikeId, app.id, weekly, weeks, total, startDate, endDate, reviewerId
      ]);
    const newAgreementId = insertRows[0].id;
    await buildPaymentSchedule(newAgreementId, weekly, weeks, startDate, client);
    return newAgreementId;
  });

  const { rows: agreementRows } = await pgDb.query('SELECT * FROM agreements WHERE id = $1', [agreementId]);
  const agreement = agreementRows[0];
  const contractPath = writeContractSnapshot({ agreement, rider, bike, application: app, kind: 'unsigned' });
  await pgDb.query(`UPDATE agreements SET contract_file_path = $1, contract_pdf_path = $2 WHERE id = $3`, [contractPath, contractPath, agreementId]);
  await pgDb.query(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      app.id,
      app.user_id,
      'unsigned_contract',
      contractPath,
      `${agreementNo}-contract.html`,
      'text/html',
      'verified',
      reviewerId
    ]);

  sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_approved',
    title: 'OnFleet application approved',
    message: `Hi ${rider.full_name.split(' ')[0]}, your application has been approved. Your bike has been allocated and your agreement ${agreementNo} is now ready for review and signature on the platform.`
  }).catch((e) => console.error('[application] approval email failed:', e.message));

  await logAudit(reviewerId, 'application.approve', 'applications', Number(applicationId), { agreementId, bikeId });
  return { ok: true, agreement_id: agreementId, agreement_no: agreementNo, contract_file_path: contractPath, bike_id: Number(bikeId) };
}

async function rejectApplication({ applicationId, reviewerId, reason }) {
  const { rows: appRows } = await pgDb.query(`SELECT a.*, u.full_name FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [applicationId]);
  const app = appRows[0];
  if (!app) throw new Error('Application not found');
  if (!['submitted', 'under_review'].includes(app.status)) {
    throw new Error('Only submitted or under review applications can be declined');
  }

  await pgDb.query(`UPDATE applications SET status = 'rejected', rejection_reason = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP WHERE id = $3`,
    [reason || null, reviewerId, applicationId]);
  sendNotification({
    userId: app.user_id,
    channel: 'email',
    type: 'application_rejected',
    title: 'OnFleet application update',
    message: `Hi ${app.full_name.split(' ')[0]}, your application has been declined. ${reason || 'Please contact OnFleet support for more information.'}`
  }).catch((e) => console.error('[application] rejection email failed:', e.message));
  await logAudit(reviewerId, 'application.reject', 'applications', Number(applicationId), { reason: reason || null });
  return { ok: true };
}

router.post('/', authRequired, async (req, res) => {
  try {
    const { rows: lastRejectedRows } = await pgDb.query(`SELECT retry_after_date FROM applications
      WHERE user_id = $1 AND status = 'rejected' AND retry_after_date IS NOT NULL
      ORDER BY submitted_at DESC LIMIT 1`, [req.user.id]);
    const lastRejected = lastRejectedRows[0];
    if (lastRejected?.retry_after_date && lastRejected.retry_after_date > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: `You can reapply after ${lastRejected.retry_after_date}` });
    }
    const id = await createApplication(req.body, req.user, req.user.id);
    res.json({ id });
  } catch (err) {
    console.error('[applications POST /]', err.message);
    res.status(500).json({ error: err.message || 'Could not create application' });
  }
});

router.post('/admin-create', authRequired, adminOnly, async (req, res) => {
  const { rows: riderRows } = await pgDb.query(`SELECT id FROM users WHERE id = $1 AND role = 'rider' AND deleted_at IS NULL`, [req.body.user_id]);
  const rider = riderRows[0];
  if (!rider) return res.status(404).json({ error: 'Rider not found' });
  const id = await createApplication(req.body, req.user, rider.id);
  res.json({ id });
});

router.post('/:id/documents', authRequired, upload.single('file'), convertHeicUploads(), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { doc_type } = req.body;
  if (!['id_document', 'drivers_license', 'payslip', 'other'].includes(doc_type)) {
    return res.status(400).json({ error: 'Invalid doc_type' });
  }

  const { rows: appRows } = await pgDb.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  const app = appRows[0];
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
  const { rows: insertRows } = await pgDb.query(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id`, [
      app.id,
      app.user_id,
      doc_type,
      publicFile,
      req.file.originalname,
      req.file.mimetype,
      insights.extracted_amount || null,
      insights.extracted_text || null,
      req.user.id
    ]);
  const id = insertRows[0].id;

  const decision = doc_type === 'payslip' ? await recalcApplicationDecision(app.id) : null;
  await logAudit(req.user.id, 'application.document_upload', 'application_documents', id, { doc_type, application_id: app.id });
  res.json({ id, extracted_amount: insights.extracted_amount || null, decision });
});

router.get('/mine', authRequired, async (req, res) => {
  const { rows: baseApps } = await pgDb.query(`SELECT a.*, b.make, b.model, b.registration, b.image_url,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.user_id = $1
    ORDER BY a.submitted_at DESC`, [req.user.id]);
  const apps = await Promise.all(baseApps.map(async (app) => ({
    ...app,
    documents: await hydrateDocuments(app.id)
  })));
  res.json({ applications: apps });
});

router.get('/', authRequired, adminOnly, async (req, res) => {
  const status = req.query.status;
  const where = [`${adminVisibleApplicationClause('a', 'u', 'b')}`];
  const values = [];
  if (status) {
    values.push(status);
    where.push(`a.status = $${values.length}`);
  }
  const sql = `SELECT a.*, u.full_name, u.email, u.phone, u.avatar_url, b.make, b.model, b.registration, b.image_url,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.submitted_at DESC`;
  const { rows: apps } = await pgDb.query(sql, values);
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

router.patch('/:id/admin-update', authRequired, adminOnly, async (req, res) => {
  const applicationId = Number(req.params.id);
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    return res.status(400).json({ error: 'Invalid application id' });
  }

  const current = await getApplicationWithRelations(applicationId, { adminVisible: true });
  if (!current) return res.status(404).json({ error: 'Application not found' });

  const userUpdates = [];
  const userValues = [];
  const applicationUpdates = [];
  const applicationValues = [];

  if (req.body.full_name !== undefined) {
    const fullName = String(req.body.full_name || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name is required' });
    userValues.push(fullName);
    userUpdates.push(`full_name = $${userValues.length}`);
  }

  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    const { rows: conflictRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND id != $2 AND deleted_at IS NULL', [email, current.user_id]);
    if (conflictRows[0]) return res.status(409).json({ error: 'Email already exists for another user' });
    userValues.push(email);
    userUpdates.push(`email = $${userValues.length}`);
  }

  for (const field of ['phone', 'id_number', 'address', 'city', 'province']) {
    if (req.body[field] !== undefined) {
      userValues.push(String(req.body[field] || '').trim() || null);
      userUpdates.push(`${field} = $${userValues.length}`);
    }
  }

  if (req.body.preferred_bike_id !== undefined) {
    const bikeId = req.body.preferred_bike_id ? Number(req.body.preferred_bike_id) : null;
    if (bikeId !== null && !Number.isInteger(bikeId)) return res.status(400).json({ error: 'Invalid preferred bike' });
    if (bikeId !== null) {
      const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [bikeId]);
      if (!bikeRows[0]) return res.status(404).json({ error: 'Preferred bike not found' });
    }
    applicationValues.push(bikeId);
    applicationUpdates.push(`preferred_bike_id = $${applicationValues.length}`);
  }

  if (req.body.delivery_platforms !== undefined) {
    const platforms = Array.isArray(req.body.delivery_platforms)
      ? req.body.delivery_platforms.filter(Boolean)
      : String(req.body.delivery_platforms || '').split(',').map((item) => item.trim()).filter(Boolean);
    applicationValues.push(platforms.join(','));
    applicationUpdates.push(`delivery_platforms = $${applicationValues.length}`);
  }

  if (req.body.has_riding_experience !== undefined) {
    applicationValues.push(!!req.body.has_riding_experience);
    applicationUpdates.push(`has_riding_experience = $${applicationValues.length}`);
  }

  if (req.body.years_riding !== undefined) {
    const years = req.body.years_riding === '' || req.body.years_riding === null ? null : Number(req.body.years_riding);
    if (years !== null && (!Number.isFinite(years) || years < 0)) return res.status(400).json({ error: 'Years riding must be zero or greater' });
    applicationValues.push(years);
    applicationUpdates.push(`years_riding = $${applicationValues.length}`);
  }

  if (req.body.has_drivers_license !== undefined) {
    applicationValues.push(!!req.body.has_drivers_license);
    applicationUpdates.push(`has_drivers_license = $${applicationValues.length}`);
  }

  if (req.body.payout_preference !== undefined) {
    const payout = String(req.body.payout_preference || '').trim();
    if (!['eft', 'ewallet'].includes(payout)) return res.status(400).json({ error: 'Invalid payout preference' });
    applicationValues.push(payout);
    applicationUpdates.push(`payout_preference = $${applicationValues.length}`);
  }

  for (const field of ['bank_name', 'account_holder', 'account_number', 'branch_code', 'ewallet_number']) {
    if (req.body[field] !== undefined) {
      applicationValues.push(String(req.body[field] || '').trim() || null);
      applicationUpdates.push(`${field} = $${applicationValues.length}`);
    }
  }

  if (!userUpdates.length && !applicationUpdates.length) return res.json({ ok: true });

  await pgDb.withTransaction(async (client) => {
    if (userUpdates.length) {
      userValues.push(current.user_id);
      await client.query(`UPDATE users SET ${userUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${userValues.length}`, userValues);
    }
    if (applicationUpdates.length) {
      applicationValues.push(applicationId);
      await client.query(`UPDATE applications SET ${applicationUpdates.join(', ')}, reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP) WHERE id = $${applicationValues.length}`, applicationValues);
    }
  });

  await logAudit(req.user.id, 'application.admin_update', 'applications', applicationId, {
    user_fields_updated: userUpdates.length,
    application_fields_updated: applicationUpdates.length
  });

  res.json({ ok: true, application: await getApplicationWithRelations(applicationId) });
});

router.patch('/:id/documents/:docId', authRequired, adminOnly, async (req, res) => {
  const applicationId = Number(req.params.id);
  const documentId = Number(req.params.docId);
  if (!Number.isInteger(applicationId) || applicationId <= 0 || !Number.isInteger(documentId) || documentId <= 0) {
    return res.status(400).json({ error: 'Invalid application document id' });
  }

  const { rows: appRows } = await pgDb.query(`SELECT a.id, a.status, a.auto_decision
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    WHERE a.id = $1 AND ${adminVisibleApplicationClause('a', 'u', 'b')}`, [applicationId]);
  const app = appRows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const { rows: existingRows } = await pgDb.query('SELECT * FROM application_documents WHERE id = $1 AND application_id = $2', [documentId, applicationId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Document not found' });

  const updates = [];
  const values = [];

  if (req.body.extracted_amount !== undefined) {
    const amount = req.body.extracted_amount === '' || req.body.extracted_amount === null ? null : Number(req.body.extracted_amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return res.status(400).json({ error: 'Extracted amount must be zero or greater' });
    }
    values.push(amount);
    updates.push(`extracted_amount = $${values.length}`);
  }

  if (req.body.status !== undefined) {
    const status = String(req.body.status || '').trim();
    if (!['uploaded', 'verified', 'rejected', 'signed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid document status' });
    }
    values.push(status);
    updates.push(`status = $${values.length}`);
  }

  if (!updates.length) return res.json({ ok: true, document: existing });

  values.push(documentId);
  await pgDb.query(`UPDATE application_documents SET ${updates.join(', ')} WHERE id = $${values.length}`, values);

  let decision = null;
  if (existing.doc_type === 'payslip') {
    if (['submitted', 'under_review', 'rejected'].includes(app.status)) decision = await recalcApplicationDecision(applicationId);
    else decision = { ...(await refreshApplicationFinancials(applicationId)), decision: app.auto_decision || null };
  }

  await logAudit(req.user.id, 'application.document_update', 'application_documents', documentId, {
    application_id: applicationId,
    doc_type: existing.doc_type
  });

  const { rows: documentRows } = await pgDb.query('SELECT id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_at FROM application_documents WHERE id = $1', [documentId]);
  res.json({ ok: true, document: documentRows[0], decision });
});

router.get('/:id', authRequired, async (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const app = await getApplicationWithRelations(req.params.id, { adminVisible: isAdminPortalUser });
  if (!app) return res.status(404).json({ error: 'Not found' });
  if (app.user_id !== req.user.id && !isAdminPortalUser) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (app.user_id !== req.user.id) {
    await logAudit(req.user.id, 'application.view', 'applications', app.id, { subject_user_id: app.user_id }, req.ip);
  }

  const documents = await hydrateDocuments(app.id);
  const { rows: agreementRows } = await pgDb.query(`SELECT id, agreement_no, contract_file_path, signed_contract_path, signed_at, status
    FROM agreements WHERE application_id = $1`, [app.id]);
  res.json({ application: app, documents, agreement: agreementRows[0] });
});

router.post('/:id/approve', authRequired, adminOnly, async (req, res) => {
  try {
    const visible = await getApplicationWithRelations(req.params.id, { adminVisible: true });
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
    const visible = await getApplicationWithRelations(req.params.id, { adminVisible: true });
    if (!visible) return res.status(404).json({ error: 'Application not found' });
    const result = await rejectApplication({ applicationId: req.params.id, reviewerId: req.user.id, reason: req.body.reason });
    res.json(result);
  } catch (error) {
    res.status(error.message === 'Application not found' ? 404 : 400).json({ error: error.message });
  }
});

router.post('/:id/reopen', authRequired, adminOnly, async (req, res) => {
  const { rows: appRows } = await pgDb.query(`SELECT id, status FROM applications WHERE id = $1`, [req.params.id]);
  const app = appRows[0];
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (app.status !== 'rejected') return res.status(400).json({ error: 'Only rejected applications can be reopened' });
  await pgDb.query(`UPDATE applications SET status = 'under_review', rejection_reason = NULL, reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [req.user.id, app.id]);
  await logAudit(req.user.id, 'application.reopen', 'applications', app.id, {});
  res.json({ ok: true });
});

module.exports = router;
