const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, fleetOwnerOnly, companyRoleAllowed } = require('../middleware/auth');
const { requireValidMime } = require('../utils/validateUpload');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays, recalcScheduleStatuses, rebuildScheduleAllocations, updateAgreementBalance } = require('../utils/helpers');
const { setBikeStatus } = require('../utils/bikeStatus');
const { discontinueAgreementForStolenBike, discontinueAgreement, reinstateDiscontinuedAgreement } = require('../services/agreementLifecycle');
const { extractPayslipInsights } = require('../services/documentInsights');
const { sendNotification, sendEmail } = require('../services/notifier');
const { writeContractSnapshot } = require('../services/contracts');
const { insertImportedPaymentForFleet } = require('../services/csvImportsFleet');

const router = express.Router();
const PAYSTACK_BASE = 'https://api.paystack.co';
const RIDER_PLAN_AMOUNTS = [500, 650, 700, 750, 800, 850, 1000, 1200];
const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const MEMBER_STATUSES = ['active', 'suspended'];
const OPEN_AGREEMENT_STATUSES = ['active', 'paused', 'defaulted'];
const SERVICEABLE_BIKE_STATUSES = ['active', 'ready_to_go', 'repairs', 'not_available', 'stationary'];
const FLEET_RESOURCE_ACCESS = {
  dashboard: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'],
    manage: []
  },
  bikes: {
    view: ['fleet_owner_admin', 'fleet_owner_ops'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  agreements: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  payments: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing']
  },
  riders: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  team: {
    view: ['fleet_owner_admin'],
    manage: ['fleet_owner_admin']
  },
  billing: {
    view: ['fleet_owner_admin', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin']
  },
  wallet: {
    view: ['fleet_owner_admin', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_billing']
  },
  collections: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  hubs: {
    view: ['fleet_owner_admin', 'fleet_owner_ops'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  api_keys: {
    view: ['fleet_owner_admin'],
    manage: ['fleet_owner_admin']
  },
  tracking: {
    view: ['fleet_owner_admin', 'fleet_owner_ops'],
    manage: ['fleet_owner_admin', 'fleet_owner_ops']
  },
  reporting: {
    view: ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'],
    manage: []
  }
};

function canViewFleetResource(role, resourceKey) {
  return (FLEET_RESOURCE_ACCESS[resourceKey]?.view || []).includes(role);
}

function canManageFleetResource(role, resourceKey) {
  return (FLEET_RESOURCE_ACCESS[resourceKey]?.manage || []).includes(role);
}

const { applications: applicationUploadDir } = require('../uploadPaths');

const riderApplicationUpload = multer({
  storage: multer.diskStorage({
    destination: applicationUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const blocked = ['application/x-msdownload', 'application/x-sh', 'text/html'];
    cb(blocked.includes(file.mimetype) ? new Error('File type not allowed') : null, !blocked.includes(file.mimetype));
  }
});

function parsePlatforms(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function boolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function requiredFile(req, field) {
  return req.files?.[field]?.[0] || null;
}

function publicApplicationPath(file) {
  return `/uploads/applications/${file.filename}`;
}

function getFleetCatalogBikes(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT b.id, b.make, b.model, b.year, b.engine_cc, b.condition, b.rental_weekly, b.total_weeks, b.image_url, b.status, b.registration
    FROM bikes b
    WHERE b.status = 'ready_to_go' AND ${scope.clause}
    ORDER BY b.make, b.model, b.year DESC, b.id DESC`).all(...scope.params);
}

function getFleetApplicationDocuments(applicationId) {
  return db.prepare(`SELECT id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_at
    FROM application_documents WHERE application_id = ? ORDER BY uploaded_at DESC, id DESC`).all(applicationId);
}

function getFleetApplicationAgreement(applicationId) {
  return db.prepare(`SELECT id, agreement_no, contract_file_path, signed_contract_path, signed_at, status, bike_id, user_id, start_date, end_date, weekly_amount, total_weeks, total_amount
    FROM agreements WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(applicationId);
}

async function approveFleetApplication({ organization, applicationId, bikeId, weeklyAmount, totalWeeks, startDate, reviewerId }) {
  const application = getScopedFleetApplication(organization, Number(applicationId));
  if (!application) throw new Error('Application not found');
  if (!['submitted', 'under_review'].includes(application.status)) {
    throw new Error('Only submitted or under review applications can be approved');
  }

  const selectedBikeId = toInt(bikeId) || toInt(application.preferred_bike_id);
  if (!selectedBikeId) throw new Error('bike_id is required');

  const rider = db.prepare(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`).get(application.user_id);
  if (!rider) throw new Error('Rider not found');

  const bike = getScopedBike(organization, selectedBikeId);
  if (!bike) throw new Error('Bike not found');
  if (bike.status !== 'ready_to_go') throw new Error('Bike must be Ready to go before allocation');

  const riderHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE user_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(application.user_id);
  if (riderHasOpenAgreement) throw new Error('Rider already has an open agreement');

  const bikeHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(selectedBikeId);
  if (bikeHasOpenAgreement) throw new Error('Bike already has an open agreement');

  const weekly = Number(weeklyAmount || bike.rental_weekly);
  const weeks = Number(totalWeeks || bike.total_weeks || 78);
  const start = String(startDate || todayIso()).slice(0, 10);
  if (!weekly || weekly <= 0) throw new Error('Weekly amount must be greater than zero');
  if (!weeks || weeks <= 0) throw new Error('Total weeks must be greater than zero');

  const total = +(weekly * weeks).toFixed(2);
  const endDate = addDays(start, weeks * 7);
  const agreementNo = generateAgreementNo();

  const agreementId = db.transaction(() => {
    db.prepare(`UPDATE applications
      SET status = 'approved',
          reviewed_by = ?,
          reviewed_at = CURRENT_TIMESTAMP,
          rejection_reason = NULL,
          preferred_bike_id = ?
      WHERE id = ?`).run(reviewerId, selectedBikeId, application.id);

    db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(selectedBikeId);

    const info = db.prepare(`INSERT INTO agreements
      (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`).run(
        agreementNo,
        application.user_id,
        selectedBikeId,
        application.id,
        weekly,
        weeks,
        total,
        start,
        endDate,
        reviewerId
      );

    buildPaymentSchedule(info.lastInsertRowid, weekly, weeks, start);
    return info.lastInsertRowid;
  })();

  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementId);
  const refreshedApplication = db.prepare('SELECT * FROM applications WHERE id = ?').get(application.id);
  const contractPath = writeContractSnapshot({ agreement, rider, bike, application: refreshedApplication, kind: 'unsigned' });
  db.prepare(`UPDATE agreements SET contract_file_path = ?, contract_pdf_path = ? WHERE id = ?`).run(contractPath, contractPath, agreementId);
  db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      application.id,
      application.user_id,
      'unsigned_contract',
      contractPath,
      `${agreementNo}-contract.html`,
      'text/html',
      'verified',
      reviewerId
    );

  sendNotification({
    userId: application.user_id,
    channel: 'email',
    type: 'application_approved',
    title: 'OnFleet application approved',
    message: `Hi ${rider.full_name.split(' ')[0]}, your application has been approved. Your bike has been allocated and your agreement ${agreementNo} is now ready for review and signature on the platform.`
  }).catch((e) => console.error('[fleet] approval email failed:', e.message));

  logAudit(reviewerId, 'fleet_owner.rider_application_approve', 'applications', Number(application.id), {
    organization_id: organization.id,
    agreement_id: agreementId,
    bike_id: selectedBikeId,
    weekly_amount: weekly,
    total_weeks: weeks,
    start_date: start
  }, null);

  return { ok: true, agreement_id: agreementId, agreement_no: agreementNo, contract_file_path: contractPath, bike_id: Number(selectedBikeId) };
}

async function rejectFleetApplication({ organization, applicationId, reviewerId, reason }) {
  const application = getScopedFleetApplication(organization, Number(applicationId));
  if (!application) throw new Error('Application not found');
  if (!['submitted', 'under_review'].includes(application.status)) {
    throw new Error('Only submitted or under review applications can be declined');
  }

  const cleanReason = String(reason || '').trim() || null;
  db.prepare(`UPDATE applications
    SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(cleanReason, reviewerId, application.id);

  sendNotification({
    userId: application.user_id,
    channel: 'email',
    type: 'application_rejected',
    title: 'OnFleet application update',
    message: `Hi ${application.full_name.split(' ')[0]}, your application has been declined. ${cleanReason || 'Please contact your fleet owner for more information.'}`
  }).catch((e) => console.error('[fleet] rejection email failed:', e.message));

  logAudit(reviewerId, 'fleet_owner.rider_application_reject', 'applications', Number(application.id), {
    organization_id: organization.id,
    reason: cleanReason
  }, null);

  return { ok: true };
}

function getScopedFleetApplication(org, applicationId) {
  const scope = getBikeScope(org, 'pb');
  return db.prepare(`SELECT a.*, u.full_name, u.email, u.phone, u.id_number, u.date_of_birth, u.address, u.city, u.province, u.postal_code,
      u.emergency_contact_name, u.emergency_contact_phone, u.avatar_url,
      b.make, b.model, b.registration, b.image_url
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    LEFT JOIN bikes pb ON pb.id = a.preferred_bike_id
    WHERE a.id = ? AND u.deleted_at IS NULL AND (
      u.organization_id = ?
      OR (a.preferred_bike_id IS NOT NULL AND ${scope.clause})
    )`).get(applicationId, org.id, ...scope.params);
}

function listFleetRiderApplications(org) {
  const scope = getBikeScope(org, 'pb');
  return db.prepare(`SELECT a.id, a.user_id, a.preferred_bike_id, a.delivery_platforms, a.years_riding, a.has_drivers_license,
      a.payout_preference, a.total_paid_last_3, a.average_weekly_earnings, a.auto_decision, a.retry_after_date,
      a.status, a.submitted_at, a.reviewed_at,
      u.full_name, u.email, u.phone, u.city, u.province, u.avatar_url,
      b.make, b.model, b.registration,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count,
      (SELECT COUNT(*) FROM application_documents d WHERE d.application_id = a.id AND d.doc_type = 'payslip') AS payslip_count
    FROM applications a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN bikes b ON b.id = a.preferred_bike_id
    LEFT JOIN bikes pb ON pb.id = a.preferred_bike_id
    WHERE u.role = 'rider' AND u.deleted_at IS NULL AND (
      u.organization_id = ?
      OR (a.preferred_bike_id IS NOT NULL AND ${scope.clause})
    )
    ORDER BY a.submitted_at DESC, a.id DESC`).all(org.id, ...scope.params);
}

function getFleetPayslipSummary(applicationId) {
  const payslips = db.prepare(`SELECT extracted_amount FROM application_documents
    WHERE application_id = ? AND doc_type = 'payslip' AND extracted_amount IS NOT NULL
    ORDER BY uploaded_at DESC LIMIT 3`).all(applicationId);
  const total = payslips.reduce((sum, row) => sum + Number(row.extracted_amount || 0), 0);
  return {
    payslip_count: payslips.length,
    total: +total.toFixed(2),
    average: payslips.length ? +(total / payslips.length).toFixed(2) : 0
  };
}

function refreshFleetApplicationFinancials(applicationId) {
  const summary = getFleetPayslipSummary(applicationId);
  db.prepare(`UPDATE applications SET total_paid_last_3 = ?, average_weekly_earnings = ? WHERE id = ?`)
    .run(summary.total, summary.average, applicationId);
  return summary;
}

function recalcFleetApplicationDecision(applicationId) {
  const summary = refreshFleetApplicationFinancials(applicationId);
  if (summary.payslip_count < 3) return { ...summary, decision: 'insufficient_documents' };
  if (summary.average < 1000) {
    const retryAfter = addDays(todayIso(), 14);
    db.prepare(`UPDATE applications
      SET status = 'rejected', auto_decision = 'auto_declined', rejection_reason = ?, retry_after_date = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
        `Average weekly earnings of R${summary.average.toFixed(2)} are below the R1000 minimum. Please reapply after ${retryAfter}.`,
        retryAfter,
        applicationId
      );
    return { ...summary, decision: 'auto_declined', retry_after_date: retryAfter };
  }
  db.prepare(`UPDATE applications
    SET status = 'under_review', auto_decision = 'pre_approved', rejection_reason = NULL, retry_after_date = NULL
    WHERE id = ?`).run(applicationId);
  return { ...summary, decision: 'pre_approved' };
}

function insertFleetApplication(payload, actorId, userId) {
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
      JSON.stringify([]),
      payload.payout_preference || null,
      payload.bank_name || null,
      payload.account_holder || null,
      payload.account_number || null,
      payload.branch_code || null,
      payload.ewallet_number || null,
      Number(payload.total_paid_last_3 || 0),
      Number(payload.average_weekly_earnings || 0),
      payload.auto_decision || null,
      payload.status || 'submitted'
    );
  logAudit(actorId || userId, actorId ? 'fleet_owner.rider_application_create' : 'fleet_public.rider_application_create', 'applications', info.lastInsertRowid);
  return info.lastInsertRowid;
}

function upsertFleetKycDocument(userId, docType, file) {
  const publicPath = publicApplicationPath(file);
  const existing = db.prepare(`SELECT id FROM kyc_documents WHERE user_id = ? AND doc_type = ?`).get(userId, docType);
  if (existing) {
    db.prepare(`UPDATE kyc_documents SET file_path = ?, original_name = ?, uploaded_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(publicPath, file.originalname, existing.id);
  } else {
    db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
      VALUES (?,?,?,?, 'approved')`).run(userId, docType, publicPath, file.originalname);
  }
  return publicPath;
}

async function insertFleetApplicationDocument({ applicationId, userId, docType, file, uploadedBy, manualAmount }) {
  let storedDocType = docType;
  let insights = { extracted_amount: null, extracted_text: null };
  if (docType === 'payslip') {
    const isPdf = file.mimetype === 'application/pdf';
    if (isPdf) {
      insights = await extractPayslipInsights(path.join(applicationUploadDir, file.filename), file.mimetype);
    }
    const cleanManual = manualAmount ? Number(String(manualAmount).replace(/[^0-9.]/g, '')) : null;
    if (!insights.extracted_amount && cleanManual && cleanManual > 0) {
      insights = {
        extracted_amount: cleanManual,
        extracted_text: isPdf ? 'Manual amount entered for PDF payslip' : 'Manual amount entered (non-PDF payslip)'
      };
    }
  }
  if (docType === 'selfie') {
    storedDocType = 'other';
    const avatarUrl = publicApplicationPath(file);
    db.prepare(`UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(avatarUrl, userId);
    upsertFleetKycDocument(userId, 'selfie', file);
  }
  if (docType === 'id_document' || docType === 'drivers_license') {
    upsertFleetKycDocument(userId, docType, file);
  }
  const info = db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      applicationId,
      userId,
      storedDocType,
      publicApplicationPath(file),
      file.originalname,
      file.mimetype,
      insights.extracted_amount || null,
      insights.extracted_text || null,
      uploadedBy || null
    );
  return { id: info.lastInsertRowid, ...insights, storedDocType };
}

function buildFleetRiderPayload(body, preferredBikeId) {
  return {
    preferred_bike_id: preferredBikeId,
    delivery_platforms: parsePlatforms(body.delivery_platforms),
    has_riding_experience: boolish(body.has_riding_experience, true),
    years_riding: body.years_riding === '' || body.years_riding === undefined ? null : Number(body.years_riding),
    has_drivers_license: boolish(body.has_drivers_license, true),
    payout_preference: String(body.payout_preference || 'eft').trim(),
    bank_name: String(body.bank_name || '').trim() || null,
    account_holder: String(body.account_holder || '').trim() || null,
    account_number: String(body.account_number || '').trim() || null,
    branch_code: String(body.branch_code || '').trim() || null,
    ewallet_number: String(body.ewallet_number || '').trim() || null
  };
}

function createFleetRiderUser({ email, full_name, phone, id_number, address, city, province, postal_code, date_of_birth, emergency_contact_name, emergency_contact_phone, organizationId }) {
  const generatedPassword = crypto.randomBytes(16).toString('hex');
  const passwordHash = bcrypt.hashSync(generatedPassword, 10);
  const info = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
     date_of_birth, emergency_contact_name, emergency_contact_phone, role, organization_id, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'rider', ?, 'active')`).run(
      email,
      passwordHash,
      full_name,
      phone || null,
      id_number || null,
      address || null,
      city || null,
      province || null,
      postal_code || null,
      date_of_birth || null,
      emergency_contact_name || null,
      emergency_contact_phone || null,
      organizationId
    );
  return info.lastInsertRowid;
}

router.get('/public/:slug/context', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  const organization = db.prepare(`SELECT id, name, slug, city, status FROM organizations WHERE LOWER(slug) = ?`).get(slug);
  if (!organization) return res.status(404).json({ error: 'Fleet owner link not found' });
  res.json({ organization, bikes: getFleetCatalogBikes(organization) });
});

router.post('/public/:slug/rider-application', riderApplicationUpload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'drivers_license', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'payslip_1', maxCount: 1 },
  { name: 'payslip_2', maxCount: 1 },
  { name: 'payslip_3', maxCount: 1 }
]), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    const organization = db.prepare(`SELECT * FROM organizations WHERE LOWER(slug) = ?`).get(slug);
    if (!organization) return res.status(404).json({ error: 'Fleet owner link not found' });

    const email = String(req.body.email || '').trim().toLowerCase();
    const full_name = String(req.body.full_name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const id_number = String(req.body.id_number || '').trim();
    const preferredBikeId = toInt(req.body.preferred_bike_id);
    if (!email || !full_name || !phone || !id_number) return res.status(400).json({ error: 'Please complete all required personal details' });
    if (!preferredBikeId) return res.status(400).json({ error: 'Please choose a preferred bike' });
    if (db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email)) return res.status(409).json({ error: 'Email already registered' });

    const bike = getScopedBike(organization, preferredBikeId);
    if (!bike || bike.status !== 'ready_to_go') return res.status(400).json({ error: 'Selected bike is not available for this fleet owner' });
    for (const field of ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3']) {
      if (!requiredFile(req, field)) return res.status(400).json({ error: `Missing required file: ${field.replace(/_/g, ' ')}` });
    }

    const payload = buildFleetRiderPayload(req.body, preferredBikeId);
    if (payload.payout_preference === 'eft' && (!payload.bank_name || !payload.account_holder || !payload.account_number || !payload.branch_code)) {
      return res.status(400).json({ error: 'Please provide all EFT banking details' });
    }
    if (payload.payout_preference === 'ewallet' && !payload.ewallet_number) {
      return res.status(400).json({ error: 'Please provide an e-wallet number' });
    }

    const userId = createFleetRiderUser({
      email,
      full_name,
      phone,
      id_number,
      address: String(req.body.address || '').trim(),
      city: String(req.body.city || '').trim(),
      province: String(req.body.province || '').trim(),
      postal_code: String(req.body.postal_code || '').trim(),
      date_of_birth: String(req.body.date_of_birth || '').trim(),
      emergency_contact_name: String(req.body.emergency_contact_name || '').trim(),
      emergency_contact_phone: String(req.body.emergency_contact_phone || '').trim(),
      organizationId: organization.id
    });
    const applicationId = insertFleetApplication(payload, null, userId);
    for (const field of ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3']) {
      const docType = field.startsWith('payslip') ? 'payslip' : field;
      const manualAmount = field.startsWith('payslip') ? req.body[`${field}_amount`] : null;
      await insertFleetApplicationDocument({ applicationId, userId, docType, file: requiredFile(req, field), uploadedBy: userId, manualAmount });
    }
    const decision = recalcFleetApplicationDecision(applicationId);
    res.status(201).json({ ok: true, application_id: applicationId, decision });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not submit rider application' });
  }
});

router.use(authRequired, fleetOwnerOnly);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getOrganization(organizationId) {
  return db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(organizationId);
}

function getOrganizationOrThrow(organizationId, { allowExpired = false } = {}) {
  const organization = getOrganization(organizationId);
  if (!organization) {
    const error = new Error('Organization not found');
    error.status = 404;
    throw error;
  }
  // Auto-expire trial on every request so the status is always accurate
  if (organization.status === 'trialing' && organization.trial_ends_at) {
    if (new Date(organization.trial_ends_at) < new Date()) {
      db.prepare("UPDATE organizations SET status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(organization.id);
      organization.status = 'past_due';
    }
  }
  if (!allowExpired && ['past_due', 'suspended', 'cancelled'].includes(organization.status)) {
    const error = new Error('Your subscription has ended. Go to Billing to upgrade your plan.');
    error.status = 402;
    error.code = 'SUBSCRIPTION_REQUIRED';
    throw error;
  }
  return organization;
}

function getBikeScope(org, alias = 'b') {
  return {
    clause: `(${alias}.organization_id = ? OR (${alias}.organization_id IS NULL AND LOWER(TRIM(COALESCE(${alias}.fleet, ''))) IN (?, ?)))`,
    params: [org.id, normalizeText(org.name), normalizeText(org.slug)]
  };
}

function getFleetMembers(organizationId) {
  return db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at
    FROM users
    WHERE organization_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC`).all(organizationId);
}

function getScopedBike(org, bikeId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT b.* FROM bikes b WHERE b.id = ? AND ${scope.clause}`).get(bikeId, ...scope.params);
}

function getScopedAgreement(org, agreementId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT a.*, b.registration AS bike_registration, b.make AS bike_make, b.model AS bike_model, b.status AS bike_status,
      u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.id = ? AND ${scope.clause}`).get(agreementId, ...scope.params);
}

function getScopedRider(org, riderId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT u.id, u.full_name, u.email, u.phone
    FROM users u
    WHERE u.id = ? AND u.role = 'rider' AND u.deleted_at IS NULL AND (
      EXISTS(
        SELECT 1
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE a.user_id = u.id AND ${scope.clause}
      )
      OR EXISTS(
        SELECT 1
        FROM applications ap
        JOIN bikes b ON b.id = ap.preferred_bike_id
        WHERE ap.user_id = u.id AND ap.status IN ('approved', 'submitted', 'under_review') AND ${scope.clause}
      )
    )`).get(riderId, ...scope.params, ...scope.params);
}

function getFleetBikes(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT b.id, b.registration, b.make, b.model, b.year, b.fleet, b.status, b.rental_weekly, b.total_weeks,
      b.odometer_km, b.next_service_date, b.next_service_km, b.last_location_at, b.last_known_lat, b.last_known_lng,
      a.id AS agreement_id, a.agreement_no, a.status AS agreement_status, a.weekly_amount,
      u.id AS rider_id, u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
      COALESCE((
        SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
        FROM payment_schedules ps
        WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
      ), 0) AS overdue_balance,
      COALESCE((
        SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        WHERE p.agreement_id = a.id AND p.status = 'success'
      ), 0) AS paid_total,
      (
        SELECT MAX(s.service_date)
        FROM service_records s
        WHERE s.bike_id = b.id AND s.service_date <= date('now')
      ) AS last_service_date
    FROM bikes b
    LEFT JOIN agreements a ON a.id = (
      SELECT a2.id
      FROM agreements a2
      WHERE a2.bike_id = b.id
      ORDER BY CASE
        WHEN a2.status = 'active' THEN 0
        WHEN a2.status = 'paused' THEN 1
        WHEN a2.status = 'defaulted' THEN 2
        WHEN a2.status = 'completed' THEN 3
        ELSE 4
      END, a2.created_at DESC, a2.id DESC
      LIMIT 1
    )
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${scope.clause}
    ORDER BY CASE
      WHEN b.status = 'active' THEN 0
      WHEN b.status = 'ready_to_go' THEN 1
      WHEN b.status = 'repairs' THEN 2
      ELSE 3
    END,
    COALESCE(b.next_service_date, '9999-12-31') ASC,
    COALESCE(b.registration, '') ASC,
    b.id DESC`).all(...scope.params);
}

function getFleetAgreements(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT a.id, a.agreement_no, a.status, a.weekly_amount, a.total_amount, a.total_weeks, a.start_date, a.end_date, a.notes, a.discontinued_reason,
      b.id AS bike_id, b.registration AS bike_registration, b.make, b.model, b.status AS bike_status,
      u.id AS rider_id, u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
      COALESCE((
        SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        WHERE p.agreement_id = a.id AND p.status = 'success'
      ), 0) AS paid_total,
      COALESCE((
        SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
        FROM payment_schedules ps
        WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
      ), 0) AS overdue_balance
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${scope.clause}
    ORDER BY CASE
      WHEN a.status = 'defaulted' THEN 0
      WHEN a.status = 'active' THEN 1
      WHEN a.status = 'paused' THEN 2
      ELSE 3
    END,
    a.created_at DESC,
    a.id DESC`).all(...scope.params).map((agreement) => ({
      ...agreement,
      remaining_balance: Math.max(Number(agreement.total_amount || 0) - Number(agreement.paid_total || 0), 0)
    }));
}

function getRecentServices(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT s.id, s.bike_id, s.agreement_id, s.service_date, s.odometer_km, s.service_type, s.description, s.cost,
      s.next_service_km, s.next_service_date, s.performed_by, s.invoice_file_path, s.invoice_original_name, s.created_at,
      b.registration, b.make, b.model
    FROM service_records s
    JOIN bikes b ON b.id = s.bike_id
    WHERE ${scope.clause}
    ORDER BY s.service_date DESC, s.id DESC
    LIMIT 25`).all(...scope.params);
}

function getRiderOptions(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT DISTINCT u.id, u.full_name, u.email, u.phone,
      CASE WHEN EXISTS(
        SELECT 1 FROM agreements a2
        WHERE a2.user_id = u.id AND a2.status IN ('active', 'paused', 'defaulted')
      ) THEN 1 ELSE 0 END AS has_open_agreement,
      (
        SELECT b2.registration
        FROM agreements a3
        JOIN bikes b2 ON b2.id = a3.bike_id
        WHERE a3.user_id = u.id AND a3.status IN ('active', 'paused', 'defaulted')
        ORDER BY CASE
          WHEN a3.status = 'active' THEN 0
          WHEN a3.status = 'paused' THEN 1
          ELSE 2
        END, a3.created_at DESC, a3.id DESC
        LIMIT 1
      ) AS current_bike_registration
    FROM users u
    WHERE u.role = 'rider' AND u.deleted_at IS NULL AND (
      EXISTS(
        SELECT 1
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE a.user_id = u.id AND ${scope.clause}
      )
      OR EXISTS(
        SELECT 1
        FROM applications ap
        JOIN bikes b ON b.id = ap.preferred_bike_id
        WHERE ap.user_id = u.id AND ap.status IN ('approved', 'submitted', 'under_review') AND ${scope.clause}
      )
    )
    ORDER BY has_open_agreement ASC, u.full_name ASC`).all(...scope.params, ...scope.params);
}

function buildCollectionsQueue(agreements) {
  return agreements
    .filter((agreement) => Number(agreement.overdue_balance || 0) > 0 || agreement.status === 'defaulted')
    .sort((a, b) => Number(b.overdue_balance || 0) - Number(a.overdue_balance || 0))
    .slice(0, 8)
    .map((agreement) => ({
      agreement_id: agreement.id,
      agreement_no: agreement.agreement_no,
      rider_name: agreement.rider_name,
      bike_registration: agreement.bike_registration,
      amount: Number(agreement.overdue_balance || 0),
      stage: agreement.status === 'defaulted' ? 'Default action' : 'Overdue this week',
      note: agreement.status === 'defaulted'
        ? 'Review rider performance, confirm payment plan, and decide whether reassignment is required.'
        : 'Send a reminder and confirm collection follow-up before the next weekly cutoff.'
    }));
}

function buildSummary(bikes, agreements, members, recentServices) {
  const today = todayIso();
  const weekAhead = addDays(today, 7);
  const activeBikes = bikes.filter((bike) => bike.status === 'active').length;
  const readyBikes = bikes.filter((bike) => bike.status === 'ready_to_go').length;
  const repairBikes = bikes.filter((bike) => bike.status === 'repairs').length;
  const defaultedAgreements = agreements.filter((agreement) => agreement.status === 'defaulted').length;
  const overdueAmount = agreements.reduce((sum, agreement) => sum + Number(agreement.overdue_balance || 0), 0);
  const openAgreements = agreements.filter((agreement) => OPEN_AGREEMENT_STATUSES.includes(agreement.status)).length;
  const adminSeatsUsed = members.filter((member) => ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'].includes(member.role)).length;
  const upcomingServices = bikes.filter((bike) => bike.next_service_date && bike.next_service_date >= today).length;
  const dueThisWeek = bikes.filter((bike) => bike.next_service_date && bike.next_service_date >= today && bike.next_service_date <= weekAhead).length;
  return {
    bike_count: bikes.length,
    active_bikes: activeBikes,
    ready_bikes: readyBikes,
    bikes_in_repairs: repairBikes,
    open_agreements: openAgreements,
    defaulted_agreements: defaultedAgreements,
    overdue_amount: +overdueAmount.toFixed(2),
    admin_seats_used: adminSeatsUsed,
    assigned_riders: bikes.filter((bike) => bike.rider_id).length,
    upcoming_services: upcomingServices,
    due_this_week: dueThisWeek,
    recent_service_logs: recentServices.length
  };
}

function getFleetPaymentsPaged(org, { search, method, days, page, pageSize, all } = {}) {
  const scope = getBikeScope(org, 'b');
  const conditions = [scope.clause];
  const params = [...scope.params];

  if (method) { conditions.push('p.method = ?'); params.push(method); }
  if (days) { conditions.push("COALESCE(p.paid_at, p.created_at) >= date('now', ?)"); params.push(`-${days} days`); }
  if (search) {
    const q = `%${search}%`;
    conditions.push("(u.full_name LIKE ? OR u.email LIKE ? OR a.agreement_no LIKE ? OR COALESCE(p.reference,'') LIKE ? OR COALESCE(b.registration,'') LIKE ?)");
    params.push(q, q, q, q, q);
  }

  const baseFrom = `FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = p.user_id
    WHERE ${conditions.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS cnt ${baseFrom}`).get(...params).cnt;
  const agg = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN p.status='success' THEN COALESCE(p.net_amount,p.amount,0) ELSE 0 END),0) AS credited,
    COALESCE(SUM(CASE WHEN p.status='success' THEN COALESCE(p.fee_amount,0) ELSE 0 END),0) AS fees,
    COALESCE(SUM(CASE WHEN p.status='success' THEN COALESCE(p.amount,0) ELSE 0 END),0) AS gross
    ${baseFrom}`).get(...params);

  const safeSize = Math.min(200, Math.max(1, Number(pageSize) || 15));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeSize;
  const limitClause = all ? '' : `LIMIT ${safeSize} OFFSET ${offset}`;

  const payments = db.prepare(`SELECT p.*, u.full_name, u.email, a.agreement_no,
      b.registration AS bike_registration, b.make, b.model, b.status AS bike_status,
      a.status AS agreement_status
    ${baseFrom}
    ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
    ${limitClause}`).all(...params);

  return {
    payments,
    total,
    page: safePage,
    pageSize: safeSize,
    pages: Math.ceil(total / safeSize) || 1,
    aggregates: { credited: agg.credited, fees: agg.fees, gross: agg.gross }
  };
}

function getScopedPayment(org, paymentId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT p.*, a.agreement_no, a.status AS agreement_status,
      b.id AS bike_id, b.registration AS bike_registration, b.status AS bike_status,
      u.full_name, u.email
    FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND ${scope.clause}`).get(paymentId, ...scope.params);
}

function creditedAmount(payment) {
  return Number(payment?.net_amount || payment?.amount || 0);
}

function applyPaymentToSchedule(agreementId, amountZAR) {
  const agreement = db.prepare('SELECT status FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ?
    AND status != 'paid' AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  let remaining = amountZAR;
  const upd = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`);
  for (const row of schedule) {
    if (remaining <= 0) break;
    const owe = +(row.amount_due - row.amount_paid).toFixed(2);
    const apply = Math.min(remaining, owe);
    const newPaid = +(row.amount_paid + apply).toFixed(2);
    const status = newPaid >= row.amount_due ? 'paid' : 'partial';
    const paidAt = status === 'paid' ? new Date().toISOString() : row.paid_at;
    upd.run(newPaid, status, paidAt, row.id);
    remaining = +(remaining - apply).toFixed(2);
  }
  recalcScheduleStatuses(agreementId);
  return remaining;
}

function recordFleetManualPayment({ agreement_id, amount, method, reference, paid_at, notes, recorded_by }) {
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement_id);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const ref = reference || `FLEET-MAN-${Date.now()}`;
  const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES (?,?,?,?, ?, ?, 'success', ?, ?, ?, ?, ?)`).run(
      agreement_id,
      agreement.user_id,
      Number(amount),
      'ZAR',
      method || 'eft',
      ref,
      paid_at || new Date().toISOString(),
      recorded_by || null,
      notes || null,
      0,
      Number(amount)
    );
  applyPaymentToSchedule(agreement_id, Number(amount));
  return { id: info.lastInsertRowid, reference: ref };
}

function sanitizePortalDataForRole(role, portalData) {
  const canViewBikes = canViewFleetResource(role, 'bikes');
  const canViewAgreements = canViewFleetResource(role, 'agreements');
  const canViewPayments = canViewFleetResource(role, 'payments');
  const canViewTeam = canViewFleetResource(role, 'team');
  const canManageAgreements = canManageFleetResource(role, 'agreements');

  return {
    ...portalData,
    members: canViewTeam ? portalData.members : [],
    bikes: canViewBikes ? portalData.bikes : [],
    agreements: canViewAgreements ? portalData.agreements : [],
    recent_services: canViewBikes ? portalData.recent_services : [],
    upcoming_services: canViewBikes ? portalData.upcoming_services : [],
    rider_options: canManageAgreements ? portalData.rider_options : [],
    collections_queue: (canViewAgreements || canViewPayments) ? portalData.collections_queue : []
  };
}

function getRevenue30d(org) {
  const scope = getBikeScope(org, 'b');
  const cutoff = addDays(todayIso(), -30);
  const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(p.net_amount, p.amount)), 0) AS total
    FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    WHERE p.status = 'success' AND ${scope.clause} AND COALESCE(p.paid_at, p.created_at) >= ?`).get(...scope.params, cutoff);
  return +(Number(row?.total || 0).toFixed(2));
}

function getPortalData(org, role) {
  const members = getFleetMembers(org.id);
  const bikes = getFleetBikes(org);
  const agreements = getFleetAgreements(org);
  const recentServices = getRecentServices(org);
  const revenue30d = getRevenue30d(org);
  const upcomingServices = bikes
    .filter((bike) => bike.next_service_date)
    .sort((a, b) => String(a.next_service_date).localeCompare(String(b.next_service_date)))
    .slice(0, 12)
    .map((bike) => ({
      bike_id: bike.id,
      registration: bike.registration,
      bike_label: [bike.make, bike.model].filter(Boolean).join(' '),
      rider_name: bike.rider_name,
      next_service_date: bike.next_service_date,
      next_service_km: bike.next_service_km,
      odometer_km: bike.odometer_km,
      status: bike.status
    }));

  return sanitizePortalDataForRole(role, {
    organization: org,
    members,
    bikes,
    agreements,
    recent_services: recentServices,
    upcoming_services: upcomingServices,
    rider_options: getRiderOptions(org),
    collections_queue: buildCollectionsQueue(agreements),
    summary: { ...buildSummary(bikes, agreements, members, recentServices), revenue_30d: revenue30d },
    live_updated_at: new Date().toISOString()
  });
}

router.get('/account', companyRoleAllowed(FLEET_RESOURCE_ACCESS.dashboard.view), (req, res) => {
  const organization = getOrganization(req.user.organization_id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  const members = canViewFleetResource(req.user.role, 'team') ? getFleetMembers(req.user.organization_id) : [];
  res.json({ organization, members });
});

router.get('/portal-data', companyRoleAllowed(FLEET_RESOURCE_ACCESS.dashboard.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    res.json(getPortalData(organization, req.user.role));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load fleet portal data' });
  }
});

router.get('/riders/share-link', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.view), (req, res) => {
  const organization = getOrganization(req.user.organization_id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  res.json({ slug: organization.slug, path: `/fleet/rider-apply/${organization.slug}` });
});

function computePerformanceScore(riderId) {
  const schedule = db.prepare(`SELECT ps.status, ps.amount_due, ps.amount_paid, a.total_weeks
    FROM payment_schedules ps
    JOIN agreements a ON a.id = ps.agreement_id
    WHERE a.user_id = ? AND a.status IN ('active','paused','defaulted','completed')
    ORDER BY ps.week_number ASC`).all(riderId);
  if (!schedule.length) return null;
  const total = schedule.length;
  const paid = schedule.filter((row) => row.status === 'paid').length;
  const overdue = schedule.filter((row) => row.status === 'overdue').length;
  const defaulted = schedule.some((row) => row.status === 'overdue' && Number(row.amount_due) > 0);
  const onTimeRate = total > 0 ? paid / total : 0;
  const statusScore = defaulted ? 0 : (overdue > 0 ? 0.4 : 1);
  const weeksTotal = schedule[0]?.total_weeks || total;
  const progressRate = weeksTotal > 0 ? Math.min(paid / weeksTotal, 1) : 0;
  const raw = Math.round((onTimeRate * 40) + (statusScore * 40) + (progressRate * 20));
  return Math.min(100, Math.max(0, raw));
}

function performanceLabel(score) {
  if (score === null) return null;
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Fair';
  return 'At Risk';
}

router.get('/riders', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const riders = listFleetRiderApplications(organization).map((rider) => {
      const score = rider.status === 'approved' ? computePerformanceScore(rider.user_id) : null;
      return { ...rider, performance_score: score, performance_label: performanceLabel(score) };
    });
    res.json({ riders });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load riders' });
  }
});

router.get('/riders/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const application = getScopedFleetApplication(organization, Number(req.params.id));
    if (!application) return res.status(404).json({ error: 'Rider application not found' });
    res.json({ application, documents: getFleetApplicationDocuments(application.id), agreement: getFleetApplicationAgreement(application.id) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load rider details' });
  }
});

router.post('/riders', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), riderApplicationUpload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'drivers_license', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'payslip_1', maxCount: 1 },
  { name: 'payslip_2', maxCount: 1 },
  { name: 'payslip_3', maxCount: 1 }
]), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const email = String(req.body.email || '').trim().toLowerCase();
    const full_name = String(req.body.full_name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const id_number = String(req.body.id_number || '').trim();
    const preferredBikeId = toInt(req.body.preferred_bike_id);
    if (!email || !email.includes('@') || !full_name || !phone || !id_number) {
      return res.status(400).json({ error: 'Full name, email, phone, and ID number are required' });
    }
    if (!preferredBikeId) return res.status(400).json({ error: 'Preferred bike is required' });
    if (db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const bike = getScopedBike(organization, preferredBikeId);
    if (!bike || bike.status !== 'ready_to_go') return res.status(400).json({ error: 'Selected bike is not available for your fleet' });
    for (const field of ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3']) {
      if (!requiredFile(req, field)) return res.status(400).json({ error: `Missing required file: ${field.replace(/_/g, ' ')}` });
    }
    const payload = buildFleetRiderPayload(req.body, preferredBikeId);
    if (payload.payout_preference === 'eft' && (!payload.bank_name || !payload.account_holder || !payload.account_number || !payload.branch_code)) {
      return res.status(400).json({ error: 'Please provide all EFT banking details' });
    }
    if (payload.payout_preference === 'ewallet' && !payload.ewallet_number) {
      return res.status(400).json({ error: 'Please provide an e-wallet number' });
    }
    const userId = createFleetRiderUser({
      email,
      full_name,
      phone,
      id_number,
      address: String(req.body.address || '').trim(),
      city: String(req.body.city || '').trim(),
      province: String(req.body.province || '').trim(),
      postal_code: String(req.body.postal_code || '').trim(),
      date_of_birth: String(req.body.date_of_birth || '').trim(),
      emergency_contact_name: String(req.body.emergency_contact_name || '').trim(),
      emergency_contact_phone: String(req.body.emergency_contact_phone || '').trim(),
      organizationId: organization.id
    });
    const applicationId = insertFleetApplication(payload, req.user.id, userId);
    for (const field of ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3']) {
      const docType = field.startsWith('payslip') ? 'payslip' : field;
      const manualAmount = field.startsWith('payslip') ? req.body[`${field}_amount`] : null;
      await insertFleetApplicationDocument({ applicationId, userId, docType, file: requiredFile(req, field), uploadedBy: req.user.id, manualAmount });
    }
    const decision = recalcFleetApplicationDecision(applicationId);
    res.status(201).json({ ok: true, application: getScopedFleetApplication(organization, applicationId), decision });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not create rider' });
  }
});

router.patch('/riders/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const applicationId = Number(req.params.id);
    const current = getScopedFleetApplication(organization, applicationId);
    if (!current) return res.status(404).json({ error: 'Rider application not found' });

    const userUpdates = [];
    const userValues = [];
    const appUpdates = [];
    const appValues = [];

    if (req.body.full_name !== undefined) {
      const fullName = String(req.body.full_name || '').trim();
      if (!fullName) return res.status(400).json({ error: 'Full name is required' });
      userUpdates.push('full_name = ?');
      userValues.push(fullName);
    }
    if (req.body.email !== undefined) {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
      const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL').get(email, current.user_id);
      if (conflict) return res.status(409).json({ error: 'Email already exists for another user' });
      userUpdates.push('email = ?');
      userValues.push(email);
    }
    for (const field of ['phone', 'id_number', 'date_of_birth', 'address', 'city', 'province', 'postal_code', 'emergency_contact_name', 'emergency_contact_phone']) {
      if (req.body[field] !== undefined) {
        userUpdates.push(`${field} = ?`);
        userValues.push(String(req.body[field] || '').trim() || null);
      }
    }
    if (req.body.preferred_bike_id !== undefined) {
      const bikeId = req.body.preferred_bike_id ? Number(req.body.preferred_bike_id) : null;
      if (bikeId !== null) {
        const bike = getScopedBike(organization, bikeId);
        if (!bike) return res.status(404).json({ error: 'Preferred bike not found in your fleet' });
      }
      appUpdates.push('preferred_bike_id = ?');
      appValues.push(bikeId);
    }
    if (req.body.delivery_platforms !== undefined) {
      appUpdates.push('delivery_platforms = ?');
      appValues.push(parsePlatforms(req.body.delivery_platforms).join(','));
    }
    if (req.body.has_riding_experience !== undefined) {
      appUpdates.push('has_riding_experience = ?');
      appValues.push(boolish(req.body.has_riding_experience) ? 1 : 0);
    }
    if (req.body.years_riding !== undefined) {
      const years = req.body.years_riding === '' || req.body.years_riding === null ? null : Number(req.body.years_riding);
      if (years !== null && (!Number.isFinite(years) || years < 0)) return res.status(400).json({ error: 'Years riding must be zero or greater' });
      appUpdates.push('years_riding = ?');
      appValues.push(years);
    }
    if (req.body.has_drivers_license !== undefined) {
      appUpdates.push('has_drivers_license = ?');
      appValues.push(boolish(req.body.has_drivers_license) ? 1 : 0);
    }
    if (req.body.payout_preference !== undefined) {
      const payout = String(req.body.payout_preference || '').trim();
      if (!['eft', 'ewallet'].includes(payout)) return res.status(400).json({ error: 'Invalid payout preference' });
      appUpdates.push('payout_preference = ?');
      appValues.push(payout);
    }
    for (const field of ['bank_name', 'account_holder', 'account_number', 'branch_code', 'ewallet_number']) {
      if (req.body[field] !== undefined) {
        appUpdates.push(`${field} = ?`);
        appValues.push(String(req.body[field] || '').trim() || null);
      }
    }
    if (!userUpdates.length && !appUpdates.length) return res.json({ ok: true, application: current });
    db.transaction(() => {
      if (userUpdates.length) db.prepare(`UPDATE users SET ${userUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...userValues, current.user_id);
      if (appUpdates.length) db.prepare(`UPDATE applications SET ${appUpdates.join(', ')}, reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP) WHERE id = ?`).run(...appValues, applicationId);
    })();
    logAudit(req.user.id, 'fleet_owner.rider_update', 'applications', applicationId, { user_fields_updated: userUpdates.length, application_fields_updated: appUpdates.length }, req.ip);
    res.json({ ok: true, application: getScopedFleetApplication(organization, applicationId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update rider' });
  }
});

router.post('/riders/:id/documents', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), riderApplicationUpload.single('file'), requireValidMime(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const applicationId = Number(req.params.id);
    const application = getScopedFleetApplication(organization, applicationId);
    if (!application) return res.status(404).json({ error: 'Rider application not found' });
    const docType = String(req.body.doc_type || '').trim();
    if (!['id_document', 'drivers_license', 'payslip', 'selfie', 'other'].includes(docType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }
    const result = await insertFleetApplicationDocument({ applicationId, userId: application.user_id, docType, file: req.file, uploadedBy: req.user.id, manualAmount: req.body.manual_payslip_amount });
    const decision = docType === 'payslip' ? recalcFleetApplicationDecision(applicationId) : null;
    logAudit(req.user.id, 'fleet_owner.rider_document_upload', 'application_documents', result.id, { application_id: applicationId, doc_type: docType }, req.ip);
    res.status(201).json({ ok: true, decision, documents: getFleetApplicationDocuments(applicationId) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not upload rider document' });
  }
});

router.post('/riders/:id/approve', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), async (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const result = await approveFleetApplication({
      organization,
      applicationId: req.params.id,
      bikeId: req.body.bike_id,
      weeklyAmount: req.body.weekly_amount,
      totalWeeks: req.body.total_weeks,
      startDate: req.body.start_date,
      reviewerId: req.user.id
    });
    res.json(result);
  } catch (error) {
    res.status(error.message === 'Application not found' || error.message === 'Bike not found' ? 404 : 400).json({ error: error.message || 'Could not approve application' });
  }
});

router.post('/riders/:id/reject', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), async (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const result = await rejectFleetApplication({
      organization,
      applicationId: req.params.id,
      reviewerId: req.user.id,
      reason: req.body.reason
    });
    res.json(result);
  } catch (error) {
    res.status(error.message == 'Application not found' ? 404 : 400).json({ error: error.message || 'Could not decline application' });
  }
});

router.post('/team-members', companyRoleAllowed(FLEET_RESOURCE_ACCESS.team.manage), (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim();
  const city = String(req.body.city || '').trim();
  const role = String(req.body.role || 'fleet_owner_viewer').trim();

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required' });
  }
  if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!FLEET_ROLE_VALUES.includes(role)) return res.status(400).json({ error: 'Invalid fleet-owner role' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const organization = db.prepare(`SELECT id, max_admin_users FROM organizations WHERE id = ?`).get(req.user.organization_id);
  const adminRoles = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'];
  const isAdminSeat = adminRoles.includes(role);
  if (isAdminSeat) {
    const usedSeats = db.prepare(`SELECT COUNT(*) c FROM users
      WHERE organization_id = ? AND deleted_at IS NULL AND role IN ('fleet_owner_admin','fleet_owner_ops','fleet_owner_billing')`).get(req.user.organization_id).c;
    if (usedSeats >= Number(organization?.max_admin_users || 0)) {
      return res.status(400).json({ error: 'Plan admin-seat limit reached for this organization' });
    }
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, phone, city, role, organization_id, status)
    VALUES (?,?,?,?,?,?,?, 'active')`).run(
      email,
      password_hash,
      full_name,
      phone || null,
      city || null,
      role,
      req.user.organization_id
    );

  logAudit(req.user.id, 'fleet_owner.team_member_create', 'users', info.lastInsertRowid, { role, organization_id: req.user.organization_id }, req.ip);
  const member = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, member });
});

router.patch('/team-members/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.team.manage), (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'Invalid team member id' });

  const member = db.prepare(`SELECT id, role, status, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(memberId);
  if (!member || member.organization_id !== req.user.organization_id) {
    return res.status(404).json({ error: 'Team member not found' });
  }
  if (member.id === req.user.id && req.body.status === 'suspended') {
    return res.status(400).json({ error: 'You cannot suspend your own account' });
  }

  const nextRole = req.body.role === undefined ? member.role : String(req.body.role).trim();
  const nextStatus = req.body.status === undefined ? member.status : String(req.body.status).trim();
  if (!FLEET_ROLE_VALUES.includes(nextRole)) return res.status(400).json({ error: 'Invalid role value' });
  if (!MEMBER_STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'Invalid status value' });

  db.prepare(`UPDATE users SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextRole, nextStatus, memberId);
  logAudit(req.user.id, 'fleet_owner.team_member_update', 'users', memberId, {
    previous_role: member.role,
    next_role: nextRole,
    previous_status: member.status,
    next_status: nextStatus
  }, req.ip);

  const updated = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(memberId);
  res.json({ ok: true, member: updated });
});

router.post('/allocations', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const riderId = toInt(req.body.rider_id);
    const startDate = String(req.body.start_date || todayIso()).slice(0, 10);

    if (!bikeId || !riderId) {
      return res.status(400).json({ error: 'Bike and rider are required' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });
    if (bike.status !== 'ready_to_go') return res.status(400).json({ error: 'Bike must be ready to go before allocation' });

    const rider = getScopedRider(organization, riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not available for your fleet' });

    const riderHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE user_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(riderId);
    if (riderHasOpenAgreement) return res.status(400).json({ error: 'Rider already has an open agreement' });

    const bikeHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(bikeId);
    if (bikeHasOpenAgreement) return res.status(400).json({ error: 'Bike already has an open agreement' });

    const weeklyAmount = toPositiveNumber(req.body.weekly_amount) || toPositiveNumber(bike.rental_weekly);
    const totalWeeks = toInt(req.body.total_weeks) || toInt(bike.total_weeks) || 78;
    if (!weeklyAmount) return res.status(400).json({ error: 'Weekly amount must be greater than zero' });

    const totalAmount = +(weeklyAmount * totalWeeks).toFixed(2);
    const endDate = addDays(startDate, totalWeeks * 7);
    const agreementNo = generateAgreementNo();
    const note = String(req.body.notes || '').trim() || null;

    const matchingApplication = db.prepare(`SELECT ap.id
      FROM applications ap
      LEFT JOIN bikes b ON b.id = ap.preferred_bike_id
      WHERE ap.user_id = ?
        AND ap.status IN ('approved', 'submitted', 'under_review')
        AND (ap.preferred_bike_id = ? OR ap.preferred_bike_id IS NULL OR b.organization_id = ?)
      ORDER BY CASE WHEN ap.preferred_bike_id = ? THEN 0 ELSE 1 END, ap.submitted_at DESC, ap.id DESC
      LIMIT 1`).get(riderId, bikeId, organization.id, bikeId);

    const created = db.transaction(() => {
      const info = db.prepare(`INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`).run(
          agreementNo,
          riderId,
          bikeId,
          matchingApplication?.id || null,
          weeklyAmount,
          totalWeeks,
          totalAmount,
          startDate,
          endDate,
          note,
          req.user.id
        );
      buildPaymentSchedule(info.lastInsertRowid, weeklyAmount, totalWeeks, startDate);
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
      return info.lastInsertRowid;
    })();

    logAudit(req.user.id, 'fleet_owner.allocate_rider', 'agreements', created, {
      organization_id: organization.id,
      bike_id: bikeId,
      rider_id: riderId,
      weekly_amount: weeklyAmount,
      total_weeks: totalWeeks,
      start_date: startDate
    }, req.ip);

    const agreement = getScopedAgreement(organization, created);
    res.status(201).json({ ok: true, agreement });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not allocate rider' });
  }
});

router.post('/reassignments', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.body.agreement_id);
    const targetBikeId = toInt(req.body.target_bike_id);
    const note = String(req.body.note || '').trim();

    if (!agreementId || !targetBikeId) {
      return res.status(400).json({ error: 'Agreement and target bike are required' });
    }

    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    if (!OPEN_AGREEMENT_STATUSES.includes(agreement.status)) {
      return res.status(400).json({ error: 'Only open agreements can be reassigned' });
    }

    const sourceBike = getScopedBike(organization, agreement.bike_id);
    const targetBike = getScopedBike(organization, targetBikeId);
    if (!targetBike) return res.status(404).json({ error: 'Target bike not found in your fleet' });
    if (Number(agreement.bike_id) === Number(targetBikeId)) return res.status(400).json({ error: 'Choose a different bike for reassignment' });
    if (targetBike.status !== 'ready_to_go') return res.status(400).json({ error: 'Target bike must be ready to go' });

    const targetHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(targetBikeId);
    if (targetHasOpenAgreement) return res.status(400).json({ error: 'Target bike already has an open agreement' });

    db.transaction(() => {
      db.prepare(`UPDATE agreements
        SET bike_id = ?,
            notes = CASE
              WHEN ? IS NOT NULL AND TRIM(?) <> '' THEN TRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE '\n' END || ?)
              ELSE notes
            END
        WHERE id = ?`).run(targetBikeId, note || null, note || null, note || null, agreementId);

      if (sourceBike?.status === 'active') {
        db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(sourceBike.id);
      }
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(targetBikeId);
    })();

    logAudit(req.user.id, 'fleet_owner.reassign_bike', 'agreements', agreementId, {
      organization_id: organization.id,
      previous_bike_id: agreement.bike_id,
      target_bike_id: targetBikeId,
      rider_id: agreement.user_id,
      note: note || null
    }, req.ip);

    const updatedAgreement = getScopedAgreement(organization, agreementId);
    res.json({ ok: true, agreement: updatedAgreement });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not reassign bike' });
  }
});

router.post('/maintenance/schedule', companyRoleAllowed(FLEET_RESOURCE_ACCESS.bikes.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const nextServiceDate = String(req.body.next_service_date || '').trim() || null;
    const nextServiceKm = req.body.next_service_km === '' || req.body.next_service_km === undefined ? null : Number(req.body.next_service_km);
    const odometerKm = req.body.odometer_km === '' || req.body.odometer_km === undefined ? null : Number(req.body.odometer_km);

    if (!bikeId) return res.status(400).json({ error: 'Bike is required' });
    if (!nextServiceDate && !Number.isFinite(nextServiceKm)) {
      return res.status(400).json({ error: 'Provide a next service date or odometer target' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });

    db.prepare(`UPDATE bikes
      SET next_service_date = ?,
          next_service_km = ?,
          odometer_km = COALESCE(?, odometer_km)
      WHERE id = ?`).run(nextServiceDate, Number.isFinite(nextServiceKm) ? nextServiceKm : null, Number.isFinite(odometerKm) ? odometerKm : null, bikeId);

    logAudit(req.user.id, 'fleet_owner.maintenance_schedule', 'bikes', bikeId, {
      organization_id: organization.id,
      next_service_date: nextServiceDate,
      next_service_km: Number.isFinite(nextServiceKm) ? nextServiceKm : null,
      odometer_km: Number.isFinite(odometerKm) ? odometerKm : null,
      notes: String(req.body.notes || '').trim() || null
    }, req.ip);

    res.json({ ok: true, bike: getScopedBike(organization, bikeId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not schedule maintenance' });
  }
});

router.post('/maintenance/log', companyRoleAllowed(FLEET_RESOURCE_ACCESS.bikes.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const serviceDate = String(req.body.service_date || '').trim();
    const serviceType = String(req.body.service_type || '').trim();
    const bikeStatusAfterService = String(req.body.bike_status_after_service || '').trim();

    if (!bikeId || !serviceDate || !serviceType) {
      return res.status(400).json({ error: 'Bike, service date, and service type are required' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });
    if (bikeStatusAfterService && !SERVICEABLE_BIKE_STATUSES.includes(bikeStatusAfterService)) {
      return res.status(400).json({ error: 'Invalid bike status after service' });
    }

    const cost = req.body.cost === '' || req.body.cost === undefined ? 0 : Number(req.body.cost);
    const odometerKm = req.body.odometer_km === '' || req.body.odometer_km === undefined ? null : Number(req.body.odometer_km);
    const nextServiceKm = req.body.next_service_km === '' || req.body.next_service_km === undefined ? null : Number(req.body.next_service_km);
    const nextServiceDate = String(req.body.next_service_date || '').trim() || null;
    const description = String(req.body.description || '').trim() || null;
    const performedBy = String(req.body.performed_by || '').trim() || null;
    const currentAgreement = db.prepare(`SELECT id FROM agreements
      WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted')
      ORDER BY CASE
        WHEN status = 'active' THEN 0
        WHEN status = 'paused' THEN 1
        ELSE 2
      END, created_at DESC, id DESC
      LIMIT 1`).get(bikeId);

    const info = db.transaction(() => {
      const insert = db.prepare(`INSERT INTO service_records
        (bike_id, agreement_id, service_date, odometer_km, service_type, description, cost, next_service_km, next_service_date, performed_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          bikeId,
          currentAgreement?.id || null,
          serviceDate,
          Number.isFinite(odometerKm) ? odometerKm : null,
          serviceType,
          description,
          Number.isFinite(cost) ? cost : 0,
          Number.isFinite(nextServiceKm) ? nextServiceKm : null,
          nextServiceDate,
          performedBy
        );

        const bikeSets = [];
        const bikeVals = [];
        if (Number.isFinite(odometerKm)) {
          bikeSets.push('odometer_km = ?');
          bikeVals.push(odometerKm);
        }
        if (nextServiceDate !== null) {
          bikeSets.push('next_service_date = ?');
          bikeVals.push(nextServiceDate);
        }
        if (Number.isFinite(nextServiceKm)) {
          bikeSets.push('next_service_km = ?');
          bikeVals.push(nextServiceKm);
        }
        if (bikeStatusAfterService) {
          bikeSets.push('status = ?');
          bikeVals.push(bikeStatusAfterService);
        }
        if (bikeSets.length) {
          bikeVals.push(bikeId);
          db.prepare(`UPDATE bikes SET ${bikeSets.join(', ')} WHERE id = ?`).run(...bikeVals);
        }
        return insert.lastInsertRowid;
      })();

      logAudit(req.user.id, 'fleet_owner.maintenance_log', 'service_records', info, {
        organization_id: organization.id,
        bike_id: bikeId,
        service_type: serviceType,
        service_date: serviceDate,
        bike_status_after_service: bikeStatusAfterService || null
      }, req.ip);

      res.status(201).json({ ok: true, service_id: info });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || 'Could not log maintenance' });
    }
  });

router.get('/bikes', companyRoleAllowed(FLEET_RESOURCE_ACCESS.bikes.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const status = String(req.query.status || '').trim();
    const fleet = String(req.query.fleet || '').trim();
    let bikes = getFleetBikes(organization);
    if (status) bikes = bikes.filter((bike) => bike.status === status);
    if (fleet) bikes = bikes.filter((bike) => String(bike.fleet || '').trim() === fleet);
    res.json({ bikes });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load bikes' });
  }
});

router.post('/bikes', companyRoleAllowed(FLEET_RESOURCE_ACCESS.bikes.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const vin = String(req.body.vin || '').trim();
    const make = String(req.body.make || '').trim();
    const model = String(req.body.model || '').trim();
    const rentalWeekly = toPositiveNumber(req.body.rental_weekly);
    if (!vin || !make || !model || !rentalWeekly) {
      return res.status(400).json({ error: 'VIN, make, model, and weekly rental are required' });
    }

    const info = db.prepare(`INSERT INTO bikes
      (vin, registration, make, model, fleet, organization_id, year, engine_cc, color, condition, purchase_price,
       rental_weekly, total_weeks, status, gps_device_id, odometer_km, insurance_provider,
       insurance_policy_no, insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        vin,
        String(req.body.registration || '').trim() || null,
        make,
        model,
        String(req.body.fleet || '').trim() || organization.name || organization.slug || null,
        organization.id,
        toInt(req.body.year) || null,
        toInt(req.body.engine_cc) || null,
        String(req.body.color || '').trim() || null,
        String(req.body.condition || 'new').trim() || 'new',
        req.body.purchase_price === '' || req.body.purchase_price === undefined ? null : Number(req.body.purchase_price),
        rentalWeekly,
        toInt(req.body.total_weeks) || 78,
        String(req.body.status || 'ready_to_go').trim() || 'ready_to_go',
        String(req.body.gps_device_id || '').trim() || null,
        toInt(req.body.odometer_km) || 0,
        String(req.body.insurance_provider || '').trim() || null,
        String(req.body.insurance_policy_no || '').trim() || null,
        String(req.body.insurance_expiry || '').trim() || null,
        String(req.body.license_disc_no || '').trim() || null,
        String(req.body.license_disc_expiry || '').trim() || null,
        String(req.body.image_url || '').trim() || null,
        String(req.body.notes || '').trim() || null
      );

    logAudit(req.user.id, 'fleet_owner.bike_create', 'bikes', info.lastInsertRowid, { organization_id: organization.id }, req.ip);
    const bike = getScopedBike(organization, info.lastInsertRowid);
    res.status(201).json({ ok: true, bike });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create bike' });
  }
});

router.put('/bikes/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.bikes.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.params.id);
    if (!bikeId) return res.status(400).json({ error: 'Invalid bike id' });
    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });

    const allowed = ['vin', 'registration', 'make', 'model', 'fleet', 'year', 'engine_cc', 'color', 'condition', 'purchase_price', 'rental_weekly', 'total_weeks', 'gps_device_id', 'odometer_km', 'next_service_km', 'next_service_date', 'insurance_provider', 'insurance_policy_no', 'insurance_expiry', 'license_disc_no', 'license_disc_expiry', 'image_url', 'notes'];
    const sets = [];
    const vals = [];
    let statusMeta = null;

    if (req.body.status !== undefined) {
      statusMeta = setBikeStatus(bikeId, req.body.status);
      if (statusMeta?.next_status === 'stolen') {
        const discontinued = discontinueAgreementForStolenBike({ bikeId, actorId: req.user.id, ip: req.ip });
        statusMeta.discontinued_agreement_id = discontinued.agreement?.id || null;
        statusMeta.discontinued_agreement_no = discontinued.agreement?.agreement_no || null;
        statusMeta.waived_schedule_rows = discontinued.waived_rows || 0;
      }
    }

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key] === '' ? null : req.body[key]);
      }
    }

    if (sets.length) {
      vals.push(bikeId);
      db.prepare(`UPDATE bikes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    logAudit(req.user.id, 'fleet_owner.bike_update', 'bikes', bikeId, { ...req.body, ...(statusMeta || {}) }, req.ip);
    res.json({ ok: true, bike: getScopedBike(organization, bikeId), ...(statusMeta || {}) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update bike' });
  }
});

router.get('/agreements', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const status = String(req.query.status || '').trim();
    const bikeStatus = String(req.query.bike_status || '').trim();
    const excludedBikeStatuses = String(req.query.exclude_bike_statuses || '').split(',').map((value) => value.trim()).filter(Boolean);
    let agreements = getFleetAgreements(organization);
    if (status) agreements = agreements.filter((agreement) => agreement.status === status);
    if (bikeStatus) agreements = agreements.filter((agreement) => agreement.bike_status === bikeStatus);
    if (excludedBikeStatuses.length) agreements = agreements.filter((agreement) => !excludedBikeStatuses.includes(agreement.bike_status));
    res.json({ agreements });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load agreements' });
  }
});

router.get('/agreements/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });
    const agreement = getScopedAgreement(org, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });

    const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`).all(agreement.id);
    const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? ORDER BY COALESCE(paid_at, created_at) DESC`).all(agreement.id);

    const successPayments = payments.filter((p) => p.status === 'success');
    const creditedAmt = (p) => Number(p.net_amount || p.amount || 0);
    const totalPaid = successPayments.reduce((sum, p) => sum + creditedAmt(p), 0);
    const weeklyAmount = Number(agreement.weekly_amount) || 0;
    const weeksPaid = weeklyAmount > 0 ? Math.floor(+(totalPaid / weeklyAmount).toFixed(10)) : 0;
    const today = new Date().toISOString().slice(0, 10);
    const nonWaived = schedule.filter((s) => s.status !== 'waived');
    const weeksDueByToday = nonWaived.filter((s) => s.due_date <= today).length;
    const overdueRaw = Math.max(0, +(weeksDueByToday * weeklyAmount - totalPaid).toFixed(2));
    const nextDue = nonWaived[weeksPaid] || null;
    const progressPct = agreement.total_amount ? +((totalPaid / agreement.total_amount) * 100).toFixed(1) : 0;
    const isDiscontinued = agreement.status === 'discontinued';

    res.json({
      agreement,
      schedule,
      payments,
      summary: {
        total_paid: +totalPaid.toFixed(2),
        remaining: isDiscontinued ? 0 : Math.max(0, +(agreement.total_amount - totalPaid).toFixed(2)),
        weeks_paid: weeksPaid,
        weeks_total: agreement.total_weeks,
        overdue: isDiscontinued ? 0 : +overdueRaw.toFixed(2),
        next_due: isDiscontinued ? null : nextDue,
        progress_pct: progressPct
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load agreement' });
  }
});

router.post('/agreements', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const riderId = toInt(req.body.rider_id);
    const startDate = String(req.body.start_date || todayIso()).slice(0, 10);

    if (!bikeId || !riderId) {
      return res.status(400).json({ error: 'Bike and rider are required' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });
    if (bike.status !== 'ready_to_go') return res.status(400).json({ error: 'Bike must be ready to go before allocation' });

    const rider = getScopedRider(organization, riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not available for your fleet' });

    const riderHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE user_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(riderId);
    if (riderHasOpenAgreement) return res.status(400).json({ error: 'Rider already has an open agreement' });

    const bikeHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(bikeId);
    if (bikeHasOpenAgreement) return res.status(400).json({ error: 'Bike already has an open agreement' });

    const weeklyAmount = toPositiveNumber(req.body.weekly_amount) || toPositiveNumber(bike.rental_weekly);
    const totalWeeks = toInt(req.body.total_weeks) || toInt(bike.total_weeks) || 78;
    if (!weeklyAmount) return res.status(400).json({ error: 'Weekly amount must be greater than zero' });

    const totalAmount = +(weeklyAmount * totalWeeks).toFixed(2);
    const endDate = addDays(startDate, totalWeeks * 7);
    const agreementNo = generateAgreementNo();
    const note = String(req.body.notes || '').trim() || null;

    const matchingApplication = db.prepare(`SELECT ap.id
      FROM applications ap
      LEFT JOIN bikes b ON b.id = ap.preferred_bike_id
      WHERE ap.user_id = ?
        AND ap.status IN ('approved', 'submitted', 'under_review')
        AND (ap.preferred_bike_id = ? OR ap.preferred_bike_id IS NULL OR b.organization_id = ?)
      ORDER BY CASE WHEN ap.preferred_bike_id = ? THEN 0 ELSE 1 END, ap.submitted_at DESC, ap.id DESC
      LIMIT 1`).get(riderId, bikeId, organization.id, bikeId);

    const created = db.transaction(() => {
      const info = db.prepare(`INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`).run(
          agreementNo,
          riderId,
          bikeId,
          matchingApplication?.id || null,
          weeklyAmount,
          totalWeeks,
          totalAmount,
          startDate,
          endDate,
          note,
          req.user.id
        );
      buildPaymentSchedule(info.lastInsertRowid, weeklyAmount, totalWeeks, startDate);
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
      return info.lastInsertRowid;
    })();

    logAudit(req.user.id, 'fleet_owner.agreement_create', 'agreements', created, {
      organization_id: organization.id,
      bike_id: bikeId,
      rider_id: riderId,
      weekly_amount: weeklyAmount,
      total_weeks: totalWeeks,
      start_date: startDate
    }, req.ip);

    const agreement = getScopedAgreement(organization, created);
    res.status(201).json({ ok: true, agreement });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create agreement' });
  }
});

router.patch('/agreements/:id/remaining-balance', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });

    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });

    const remainingBalance = req.body.remaining_balance;
    const result = updateAgreementBalance(agreementId, remainingBalance);
    logAudit(req.user.id, 'fleet_owner.agreement_remaining_balance', 'agreements', agreementId, {
      remaining_balance: result.remaining_balance,
      total_amount: result.total_amount
    }, req.ip);
    res.json({ ok: true, ...result, agreement: getScopedAgreement(organization, agreementId) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not update remaining balance' });
  }
});

router.post('/agreements/:id/status', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    const nextStatus = String(req.body.status || '').trim();
    if (!agreementId || !nextStatus) return res.status(400).json({ error: 'Agreement and status are required' });

    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });

    if (nextStatus === 'discontinued') {
      const result = discontinueAgreement({ agreementId, reason: 'fleet_owner_manual_discontinue', actorId: req.user.id, ip: req.ip, auditAction: 'fleet_owner.agreement_discontinued' });
      return res.json({ ok: true, waived_rows: result.waived_rows });
    }

    if (!['active', 'completed', 'defaulted', 'cancelled', 'paused'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(nextStatus, agreementId);
    if (nextStatus === 'completed') db.prepare(`UPDATE bikes SET status = 'paid_off' WHERE id = ?`).run(agreement.bike_id);
    if (nextStatus === 'cancelled') db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(agreement.bike_id);
    if (nextStatus === 'active') db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ? AND status <> 'active'`).run(agreement.bike_id);

    logAudit(req.user.id, 'fleet_owner.agreement_status', 'agreements', agreementId, { previous_status: agreement.status, next_status: nextStatus }, req.ip);

    if (nextStatus === 'defaulted') {
      const rider = db.prepare('SELECT full_name FROM users WHERE id = ?').get(agreement.user_id);
      const orgAdmins = db.prepare(
        `SELECT id, full_name FROM users WHERE organization_id = ? AND role IN ('fleet_owner_admin','fleet_owner_ops') AND status = 'active' AND deleted_at IS NULL`
      ).all(organization.id);
      for (const admin of orgAdmins) {
        sendNotification({
          userId: admin.id,
          channel: 'email',
          type: 'agreement_defaulted',
          title: `Agreement defaulted · ${agreement.agreement_no}`,
          message: `Hi ${admin.full_name.split(' ')[0]}, agreement ${agreement.agreement_no} for rider ${rider?.full_name || 'Unknown'} has been marked as defaulted. Open your fleet portal to begin collections or immobilise the bike.`
        }).catch((e) => console.error(`[fleet] defaulted notify failed for ${agreement.agreement_no}:`, e.message));
      }
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update agreement status' });
  }
});

router.post('/agreements/:id/reinstate', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });
    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    const result = reinstateDiscontinuedAgreement({ agreementId, actorId: req.user.id, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not reinstate agreement' });
  }
});

// POST /fleet/agreements/:id/payment-link — generate Paystack checkout link and email it to the rider
router.post('/agreements/:id/payment-link', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.manage), async (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });

    const agreement = getScopedAgreement(org, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    if (!['active', 'paused', 'defaulted'].includes(agreement.status)) {
      return res.status(400).json({ error: 'Payment links can only be sent for active, paused, or defaulted agreements' });
    }
    if (!agreement.rider_email) return res.status(400).json({ error: 'Rider has no email address on file' });

    const overrideAmount = req.body.plan_amount ? Math.round(Number(req.body.plan_amount)) : null;
    const weeklyAmount = overrideAmount || Math.round(Number(agreement.weekly_amount));

    if (overrideAmount && !FLEET_PAYMENT_PLAN_AMOUNTS.includes(overrideAmount)) {
      return res.status(400).json({ error: `Amount must be one of R${FLEET_PAYMENT_PLAN_AMOUNTS.join(', R')}` });
    }

    const planCode = getFleetPaymentPlanCode(weeklyAmount) || getRiderPlanCode(weeklyAmount);

    const reference = `RLINK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const paystackBody = {
      email: agreement.rider_email,
      amount: weeklyAmount * 100,
      currency: 'ZAR',
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      metadata: {
        type: planCode ? 'rider_subscription' : 'rider_one_time',
        organization_id: org.id,
        rider_user_id: agreement.user_id,
        agreement_id: agreement.id,
        weekly_amount: weeklyAmount
      }
    };
    if (planCode) {
      paystackBody.plan = planCode;
      const existing = db.prepare(`SELECT id FROM rider_subscriptions WHERE rider_user_id = ? AND organization_id = ? AND status = 'active'`).get(agreement.user_id, org.id);
      if (existing) return res.status(400).json({ error: 'Rider already has an active payment subscription. Cancel it first before sending a new link.' });
    }

    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, paystackBody, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const authUrl = resp.data.data.authorization_url;

    if (planCode) {
      db.prepare(`INSERT INTO rider_subscriptions (organization_id, rider_user_id, agreement_id, plan_code, weekly_amount, status) VALUES (?,?,?,?,?, 'pending')`)
        .run(org.id, agreement.user_id, agreement.id, planCode, weeklyAmount);
    }

    const orgName = org.name || 'Your fleet';
    const emailBody = `Hi ${agreement.rider_name || 'there'},

${orgName} has sent you a secure payment link for your agreement ${agreement.agreement_no}.

Weekly payment amount: R${weeklyAmount.toFixed(2)}

Click the link below to set up your card payment:
${authUrl}

This link is unique to your account. Do not share it with anyone.

If you have any questions, contact ${orgName} directly.`;

    await sendEmail(agreement.rider_email, `Payment link — ${agreement.agreement_no}`, emailBody).catch((err) => {
      console.error('[fleet:payment-link] email failed:', err.message);
    });

    logAudit(req.user.id, 'fleet_owner.payment_link_sent', 'agreements', agreement.id, {
      rider_email: agreement.rider_email,
      weekly_amount: weeklyAmount,
      reference,
      subscription: !!planCode
    }, req.ip);

    res.json({
      ok: true,
      authorization_url: authUrl,
      rider_name: agreement.rider_name,
      rider_email: agreement.rider_email,
      weekly_amount: weeklyAmount,
      is_subscription: !!planCode
    });
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    res.status(error.status || 500).json({ error: msg || 'Could not generate payment link' });
  }
});

router.get('/agreements/:id/rider-portal-token', companyRoleAllowed(FLEET_RESOURCE_ACCESS.agreements.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement ID' });
    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    const hmac = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'onfleet-fallback')
      .update(String(agreementId))
      .digest('hex')
      .slice(0, 32);
    const token = `${agreementId}.${hmac}`;
    res.json({ token, path: `/rider-portal/${token}` });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not generate portal link' });
  }
});

router.get('/payments', companyRoleAllowed(FLEET_RESOURCE_ACCESS.payments.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const search = String(req.query.search || '').trim();
    const method = String(req.query.method || '').trim();
    const days = toInt(req.query.days);
    const page = Math.max(1, toInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, toInt(req.query.page_size) || 15));
    const all = req.query.all === '1';
    res.json(getFleetPaymentsPaged(organization, { search, method, days, page, pageSize, all }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load payments' });
  }
});

router.post('/payments/manual', companyRoleAllowed(FLEET_RESOURCE_ACCESS.payments.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.body.agreement_id);
    const amount = toPositiveNumber(req.body.amount);
    if (!agreementId || !amount) return res.status(400).json({ error: 'Agreement and amount are required' });
    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    const result = recordFleetManualPayment({ ...req.body, agreement_id: agreementId, amount, recorded_by: req.user.id });
    logAudit(req.user.id, 'fleet_owner.payment_manual', 'payments', result.id, { amount, method: req.body.method, agreement_id: agreementId }, req.ip);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not record payment' });
  }
});

router.post('/payments/bulk-delete', companyRoleAllowed(FLEET_RESOURCE_ACCESS.payments.manage), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const paymentIds = Array.from(new Set((Array.isArray(req.body.payment_ids) ? req.body.payment_ids : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)));
    if (!paymentIds.length) return res.status(400).json({ error: 'Select at least one payment to delete' });

    const deleted = [];
    const notFound = [];
    const agreementIds = new Set();
    for (const paymentId of paymentIds) {
      const payment = getScopedPayment(organization, paymentId);
      if (!payment) {
        notFound.push(paymentId);
        continue;
      }
      db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
      agreementIds.add(payment.agreement_id);
      deleted.push(payment);
    }

    for (const agreementId of agreementIds) rebuildScheduleAllocations(agreementId);

    logAudit(req.user.id, 'fleet_owner.payment_bulk_delete', 'payments', null, {
      requested: paymentIds.length,
      deleted_count: deleted.length,
      not_found_count: notFound.length,
      payment_ids: deleted.map((payment) => payment.id)
    }, req.ip);

    res.json({ ok: true, requested: paymentIds.length, deleted_count: deleted.length, not_found_count: notFound.length, not_found: notFound });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not delete payments' });
  }
});

// ─── Fleet Reports ────────────────────────────────────────────────────────────

router.get('/reports', companyRoleAllowed(FLEET_RESOURCE_ACCESS.reporting.view), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const scope = getBikeScope(organization, 'b');
    const sp = scope.params;

    // Collection rate — scheduled instalments due in the last 30 days
    const collectionRate = db.prepare(`
      SELECT
        COALESCE(SUM(ps.amount_due), 0)  AS total_due,
        COALESCE(SUM(ps.amount_paid), 0) AS total_paid,
        COUNT(*) AS schedule_count,
        COALESCE(SUM(CASE WHEN ps.status = 'paid'    THEN 1 ELSE 0 END), 0) AS paid_count,
        COALESCE(SUM(CASE WHEN ps.status IN ('overdue','partial') THEN 1 ELSE 0 END), 0) AS unpaid_count
      FROM payment_schedules ps
      JOIN agreements a ON a.id = ps.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      WHERE ${scope.clause}
        AND ps.due_date >= date('now', '-30 days')
        AND ps.due_date <= date('now')
    `).get(...sp);

    // Revenue trend — monthly totals for the last 12 months
    const revenueTrend = db.prepare(`
      SELECT
        strftime('%Y-%m', COALESCE(p.paid_at, p.created_at)) AS month,
        COALESCE(SUM(COALESCE(p.net_amount, p.amount, 0)), 0) AS credited,
        COALESCE(SUM(COALESCE(p.amount, 0)), 0)              AS gross,
        COUNT(*) AS payment_count
      FROM payments p
      JOIN agreements a ON a.id = p.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      WHERE ${scope.clause}
        AND p.status = 'success'
        AND COALESCE(p.paid_at, p.created_at) >= date('now', '-12 months')
      GROUP BY strftime('%Y-%m', COALESCE(p.paid_at, p.created_at))
      ORDER BY month
    `).all(...sp);

    // Overdue aging bands — how much is owed grouped by days overdue
    const aging = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(ps.due_date) AS INTEGER) BETWEEN 1  AND 30  THEN ps.amount_due - ps.amount_paid ELSE 0 END), 0) AS band_1_30,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(ps.due_date) AS INTEGER) BETWEEN 31 AND 60  THEN ps.amount_due - ps.amount_paid ELSE 0 END), 0) AS band_31_60,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(ps.due_date) AS INTEGER) BETWEEN 61 AND 90  THEN ps.amount_due - ps.amount_paid ELSE 0 END), 0) AS band_61_90,
        COALESCE(SUM(CASE WHEN CAST(julianday('now') - julianday(ps.due_date) AS INTEGER) > 90               THEN ps.amount_due - ps.amount_paid ELSE 0 END), 0) AS band_90plus
      FROM payment_schedules ps
      JOIN agreements a ON a.id = ps.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      WHERE ${scope.clause}
        AND ps.status IN ('overdue', 'partial')
        AND ps.due_date < date('now')
        AND ps.amount_due > ps.amount_paid
    `).get(...sp);

    // Fleet utilisation
    const utilisation = db.prepare(`
      SELECT
        COUNT(*) AS total_bikes,
        COALESCE(SUM(CASE WHEN b.status IN ('active','ready_to_go','repairs','not_available','stationary') THEN 1 ELSE 0 END), 0) AS serviceable_bikes,
        COALESCE(SUM(CASE WHEN EXISTS(
          SELECT 1 FROM agreements aa
          WHERE aa.bike_id = b.id AND aa.status IN ('active','paused','defaulted')
        ) THEN 1 ELSE 0 END), 0) AS bikes_with_agreements,
        COALESCE(SUM(CASE WHEN b.status = 'active' THEN 1 ELSE 0 END), 0) AS active_bikes
      FROM bikes b
      WHERE ${scope.clause}
    `).get(...sp);

    // Agreement status breakdown
    const agreementBreakdown = db.prepare(`
      SELECT a.status, COUNT(*) AS count
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      WHERE ${scope.clause}
      GROUP BY a.status
    `).all(...sp);

    res.json({
      collection_rate: collectionRate,
      revenue_trend: revenueTrend,
      aging_bands: aging,
      utilisation,
      agreement_breakdown: agreementBreakdown
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load reports' });
  }
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/payments/import/preview', companyRoleAllowed(FLEET_RESOURCE_ACCESS.payments.manage), csvUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mime = req.file.mimetype || '';
    if (!mime.includes('csv') && !mime.includes('text') && !mime.includes('excel') && !mime.includes('spreadsheet')) {
      const ext = (req.file.originalname || '').toLowerCase();
      if (!ext.endsWith('.csv')) return res.status(400).json({ error: 'Please upload a CSV file' });
    }
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
    const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
    const sampleRows = lines.slice(1, 6).map((line) => {
      const vals = line.split(',').map((v) => v.replace(/^"|"$/g, '').trim());
      const row = {};
      headers.forEach((h, i) => { row[h] = vals[i] || ''; });
      return row;
    });
    const regCol = headers.find((h) => /reg(istration)?|bike/i.test(h));
    const amtCol = headers.find((h) => /amount|collected|payment/i.test(h));
    const dateCol = headers.find((h) => /date|paid/i.test(h));
    const refCol = headers.find((h) => /ref(erence)?/i.test(h));
    const methodCol = headers.find((h) => /method|type/i.test(h));
    const notesCol = headers.find((h) => /note|comment/i.test(h));
    res.json({
      headers,
      total_rows: lines.length - 1,
      sample_rows: sampleRows,
      suggested_mapping: { registration: regCol || null, amount: amtCol || null, paid_at: dateCol || null, reference: refCol || null, method: methodCol || null, notes: notesCol || null },
      org_name: organization.name
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not preview CSV' });
  }
});

router.post('/payments/import', companyRoleAllowed(FLEET_RESOURCE_ACCESS.payments.manage), csvUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const organization = getOrganizationOrThrow(req.user.organization_id);

    let mapping = {};
    try { mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {}; } catch (_) {}

    function parseCsvRows(text) {
      const rows = [];
      const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return rows;
      const hdrs = lines.shift().split(',').map((h) => h.replace(/^"|"$/g, '').trim());
      for (const line of lines) {
        const vals = line.split(',').map((v) => v.replace(/^"|"$/g, '').trim());
        const row = {};
        hdrs.forEach((h, i) => { row[h] = vals[i] || ''; });
        rows.push(row);
      }
      return rows;
    }

    function applyMapping(rows, map) {
      if (!map || !Object.keys(map).length) return rows;
      return rows.map((row) => {
        const out = { ...row };
        for (const [canonical, source] of Object.entries(map)) {
          if (source && row[source] !== undefined) out[canonical] = row[source];
        }
        return out;
      });
    }

    const rows = applyMapping(parseCsvRows(req.file.buffer.toString('utf8')), mapping);

    const summary = { total_rows: rows.length, payments_created: 0, skipped: 0, errors: [] };
    for (const [index, row] of rows.entries()) {
      try {
        const result = insertImportedPaymentForFleet(row, req.user.id, organization.id);
        if (result.skipped) summary.skipped += 1;
        else summary.payments_created += 1;
      } catch (error) {
        summary.errors.push({ row: index + 2, error: error.message });
      }
    }

    logAudit(req.user.id, 'fleet_owner.payments_import', 'payments', null, { ...summary, org_id: organization.id }, req.ip);
    res.json({ ok: true, ...summary });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not import payments' });
  }
});

// ─── Fleet Billing (Paystack Subscriptions) ───────────────────────────────────

const PAYSTACK_API = 'https://api.paystack.co';

const FLEET_BILLING_PLANS = {
  small:  { key: 'small',  name: 'Starter',      monthly_price: 200,   max_bikes: 6,    max_admin_users: 2,  features: ['1–6 bikes', 'R200 flat monthly', '2 admin users', 'Standard support'] },
  medium: { key: 'medium', name: 'Growth',        monthly_price: 750,   max_bikes: 20,   max_admin_users: 3,  features: ['7–20 bikes', 'R750 flat monthly', '3 admin users', 'Advanced filters', 'Performance reporting'] },
  large:  { key: 'large',  name: 'Professional',  monthly_price: 1500,  max_bikes: 35,   max_admin_users: 5,  features: ['21–35 bikes', 'R1 500 flat monthly', '5 admin users', 'Priority onboarding', 'Multi-branch support'] },
  empire: { key: 'empire', name: 'Empire',        monthly_price: 2800,  max_bikes: 9999, max_admin_users: 20, features: ['36+ bikes', 'R2 800 flat monthly', '20 admin users', 'Dedicated onboarding', 'Custom integrations', 'SLA support'] }
};

function getTierForBikeCount(count) {
  if (count <= 6)  return 'small';
  if (count <= 20) return 'medium';
  if (count <= 35) return 'large';
  return 'empire';
}

function getPlanPaystackCode(planKey) {
  const raw = process.env[`PAYSTACK_PLAN_${String(planKey).toUpperCase()}`];
  // Trim whitespace and strip inline shell-style comments (e.g. "PLN_xxx  # comment")
  const cleaned = String(raw || '').split('#')[0].trim();
  return cleaned || null;
}

function getKeyForPlanCode(planCode) {
  for (const key of Object.keys(FLEET_BILLING_PLANS)) {
    if (getPlanPaystackCode(key) === planCode) return key;
  }
  return null;
}

function applyPlanToOrg(orgId, planKey, subscriptionCode) {
  const plan = FLEET_BILLING_PLANS[planKey];
  if (!plan) return;
  const updates = [plan.max_bikes, plan.max_admin_users, planKey];
  const subUpdate = subscriptionCode ? `, paystack_subscription_code = ?` : '';
  const subParams = subscriptionCode ? [subscriptionCode] : [];
  db.prepare(`UPDATE organizations SET
    max_bikes = ?, max_admin_users = ?, plan_key = ?,
    status = 'active'${subUpdate},
    updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(...updates, ...subParams, orgId);
}

async function cancelPaystackSubscription(subscriptionCode) {
  const subResp = await axios.get(`${PAYSTACK_API}/subscription/${encodeURIComponent(subscriptionCode)}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
  const emailToken = subResp.data.data?.email_token;
  if (!emailToken) throw new Error('Paystack subscription has no email_token');
  await axios.post(`${PAYSTACK_API}/subscription/disable`,
    { code: subscriptionCode, token: emailToken },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
}

// GET /fleet/billing/diagnose — admin-only config check (does not charge)
router.get('/billing/diagnose', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.manage), async (req, res) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY || '';
  const checks = {
    secret_key_set: !!secretKey && !secretKey.includes('xxxx'),
    secret_key_env: secretKey ? secretKey.slice(0, 7) + '…' : '(not set)',
    plans: {}
  };
  for (const key of Object.keys(FLEET_BILLING_PLANS)) {
    const code = getPlanPaystackCode(key);
    checks.plans[key] = { code: code || '(not set)', valid_format: !!(code && code.startsWith('PLN_')) };
  }

  let paystackReachable = false;
  let paystackError = null;
  try {
    const r = await axios.get(`${PAYSTACK_API}/bank`, { headers: { Authorization: `Bearer ${secretKey}` }, timeout: 5000 });
    paystackReachable = r.data?.status === true;
  } catch (e) {
    paystackError = e.response?.data?.message || e.message;
  }
  checks.paystack_reachable = paystackReachable;
  checks.paystack_error = paystackError;

  res.json(checks);
});

// GET /fleet/billing/status
router.get('/billing/status', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const trialDaysLeft = (org.status === 'trialing' && org.trial_ends_at)
      ? Math.max(0, Math.round((new Date(org.trial_ends_at) - new Date()) / 86400000))
      : null;
    const bikeCount = db.prepare(`SELECT COUNT(*) c FROM bikes WHERE organization_id = ? AND status NOT IN ('retired','sold')`).get(org.id).c || 0;
    const suggestedTier = getTierForBikeCount(bikeCount);
    const currentPlan = FLEET_BILLING_PLANS[org.plan_key] || null;
    const approachingLimit = currentPlan && bikeCount >= currentPlan.max_bikes * 0.8;
    res.json({
      organization: {
        id: org.id, name: org.name, plan_key: org.plan_key, status: org.status,
        trial_ends_at: org.trial_ends_at, trial_days_left: trialDaysLeft,
        paystack_subscription_code: org.paystack_subscription_code,
        max_bikes: org.max_bikes, max_admin_users: org.max_admin_users,
        bike_count: bikeCount, monthly_price: currentPlan?.monthly_price || null,
        suggested_tier: suggestedTier, approaching_limit: approachingLimit
      },
      plans: Object.values(FLEET_BILLING_PLANS),
      can_subscribe: ['trialing', 'past_due', 'cancelled', 'suspended', 'active'].includes(org.status),
      is_active_subscriber: org.status === 'active' && !!org.paystack_subscription_code
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load billing status' });
  }
});

// POST /fleet/billing/subscribe — initialise Paystack subscription checkout
router.post('/billing/subscribe', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.manage), async (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const { plan_key } = req.body;
    if (!FLEET_BILLING_PLANS[plan_key]) return res.status(400).json({ error: 'Invalid plan key.', valid_keys: Object.keys(FLEET_BILLING_PLANS) });

    if (!process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY.includes('xxxx')) {
      return res.status(500).json({ error: 'Paystack is not configured on this server. Please set PAYSTACK_SECRET_KEY.' });
    }

    const planCode = getPlanPaystackCode(plan_key);
    if (!planCode || planCode.includes('xxxx')) {
      return res.status(400).json({ error: `The ${plan_key} plan is not yet linked to a Paystack plan code. Please set PAYSTACK_PLAN_${plan_key.toUpperCase()} in the server environment.` });
    }

    const plan = FLEET_BILLING_PLANS[plan_key];
    const amountCents = plan.monthly_price * 100;
    const reference = `OF-SUB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const initResp = await axios.post(`${PAYSTACK_API}/transaction/initialize`,
      {
        email: req.user.email,
        amount: amountCents,
        plan: planCode,
        reference,
        callback_url: `${process.env.FRONTEND_URL}/fleet/app/billing`,
        metadata: { organization_id: org.id, plan_key, type: 'fleet_subscription' }
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    if (!initResp.data?.status) {
      return res.status(400).json({ error: `Paystack rejected the request: ${initResp.data?.message || 'Unknown error'}` });
    }

    logAudit(req.user.id, 'fleet_owner.billing.subscribe_init', 'organizations', org.id, { plan_key, reference }, req.ip);
    res.json({
      authorization_url: initResp.data.data.authorization_url,
      reference,
      plan_key,
      plan: FLEET_BILLING_PLANS[plan_key]
    });
  } catch (error) {
    const paystackMsg = error.response?.data?.message || error.response?.data?.error;
    const detail = paystackMsg || error.message;
    res.status(error.response?.status || 500).json({
      error: paystackMsg ? `Paystack: ${paystackMsg}` : 'Could not initiate subscription checkout',
      details: detail
    });
  }
});

// GET /fleet/billing/verify?reference=xxx — verify subscription after redirect
router.get('/billing/verify', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.manage), async (req, res) => {
  try {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Reference is required' });
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });

    const verifyResp = await axios.get(
      `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const txn = verifyResp.data.data;
    if (txn.status !== 'success') {
      return res.status(400).json({ error: `Payment was not completed (status: ${txn.status})`, txn_status: txn.status });
    }

    const planKey = txn.metadata?.plan_key
      || (txn.plan?.plan_code ? getKeyForPlanCode(txn.plan.plan_code) : null);

    const oldSubCode = org.paystack_subscription_code || null;
    const newSubCode = txn.subscription?.subscription_code || null;

    if (planKey && FLEET_BILLING_PLANS[planKey]) {
      applyPlanToOrg(org.id, planKey, newSubCode);
    }

    // Cancel the previous subscription when switching plans
    if (oldSubCode && newSubCode && oldSubCode !== newSubCode) {
      cancelPaystackSubscription(oldSubCode).catch((e) =>
        console.error(`[billing] Could not cancel old subscription ${oldSubCode}:`, e.message));
    }

    logAudit(req.user.id, 'fleet_owner.billing.subscribe_verified', 'organizations', org.id, { reference, plan_key: planKey, switched_from: oldSubCode ? 'existing' : null }, req.ip);
    res.json({ ok: true, plan_key: planKey, txn_status: txn.status });
  } catch (error) {
    res.status(500).json({ error: 'Could not verify subscription', details: error.response?.data || error.message });
  }
});

// ---------- RIDER PAYMENT PLAN HELPERS ----------

const FLEET_PAYMENT_PLAN_AMOUNTS = [600, 650, 700, 850];

function getFleetPaymentPlanCode(weeklyAmount) {
  const amount = Math.round(Number(weeklyAmount));
  if (!FLEET_PAYMENT_PLAN_AMOUNTS.includes(amount)) return null;
  const raw = process.env[`PAYSTACK_FlEET_PLAN_${amount}`];
  return String(raw || '').split('#')[0].trim() || null;
}

function getRiderPlanCode(weeklyAmount) {
  const amount = Math.round(Number(weeklyAmount));
  for (const amt of RIDER_PLAN_AMOUNTS) {
    if (amount === amt) return process.env[`PAYSTACK_RIDER_PLAN_${amt}`] || null;
  }
  return null;
}

function ensureFleetWallet(organizationId) {
  db.prepare(`INSERT OR IGNORE INTO fleet_wallets (organization_id) VALUES (?)`).run(organizationId);
}

function creditFleetWallet(organizationId, grossAmountZAR, riderId, reference) {
  const fee = +(grossAmountZAR * 0.035 + 1).toFixed(2);
  const net = +(grossAmountZAR - fee).toFixed(2);
  ensureFleetWallet(organizationId);
  db.transaction(() => {
    db.prepare(`UPDATE fleet_wallets SET balance = balance + ?, total_collected = total_collected + ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
      .run(net, net, organizationId);
    db.prepare(`INSERT INTO fleet_wallet_transactions (organization_id, type, amount, fee_amount, net_amount, description, paystack_reference, rider_user_id)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(organizationId, 'credit', grossAmountZAR, fee, net, 'Weekly rider rental payment', reference || null, riderId || null);
  })();
  return { gross: grossAmountZAR, fee, net };
}

// GET /fleet/wallet — wallet balance and recent transactions
router.get('/wallet', companyRoleAllowed(FLEET_RESOURCE_ACCESS.wallet.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    ensureFleetWallet(org.id);
    const wallet = db.prepare('SELECT * FROM fleet_wallets WHERE organization_id = ?').get(org.id);
    const transactions = db.prepare(`SELECT t.*, u.full_name AS rider_name
      FROM fleet_wallet_transactions t
      LEFT JOIN users u ON u.id = t.rider_user_id
      WHERE t.organization_id = ?
      ORDER BY t.created_at DESC LIMIT 100`).all(org.id);
    const payoutRequests = db.prepare(`SELECT p.*, u.full_name AS requested_by_name
      FROM fleet_payout_requests p
      JOIN users u ON u.id = p.requested_by
      WHERE p.organization_id = ?
      ORDER BY p.created_at DESC LIMIT 20`).all(org.id);
    res.json({ wallet, transactions, payout_requests: payoutRequests });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /fleet/wallet/payout — request payout from wallet
router.post('/wallet/payout', companyRoleAllowed(FLEET_RESOURCE_ACCESS.wallet.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    ensureFleetWallet(org.id);
    const wallet = db.prepare('SELECT * FROM fleet_wallets WHERE organization_id = ?').get(org.id);

    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid withdrawal amount' });
    if (!wallet || wallet.balance < amount) return res.status(400).json({ error: 'Insufficient wallet balance' });

    const bankAccountName = req.body.bank_account_name || org.bank_account_name;
    const bankName = req.body.bank_name || org.bank_name;
    const bankAccountNumber = req.body.bank_account_number || org.bank_account_number;
    const bankBranchCode = req.body.bank_branch_code || org.bank_branch_code;

    if (!bankAccountName || !bankName || !bankAccountNumber) {
      return res.status(400).json({ error: 'Bank account name, bank name, and account number are required' });
    }

    const withdrawalFee = +(amount * 0.005).toFixed(2);
    const netPayout = +(amount - withdrawalFee).toFixed(2);

    const requestId = db.transaction(() => {
      db.prepare(`UPDATE fleet_wallets SET balance = balance - ?, total_withdrawn = total_withdrawn + ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
        .run(amount, amount, org.id);

      const result = db.prepare(`INSERT INTO fleet_payout_requests
        (organization_id, requested_by, amount_requested, withdrawal_fee, net_payout, status, bank_account_name, bank_name, bank_account_number, bank_branch_code)
        VALUES (?,?,?,?,?, 'pending',?,?,?,?)`)
        .run(org.id, req.user.id, amount, withdrawalFee, netPayout, bankAccountName, bankName, bankAccountNumber, bankBranchCode || null);

      const reqId = result.lastInsertRowid;
      db.prepare(`INSERT INTO fleet_wallet_transactions
        (organization_id, type, amount, fee_amount, net_amount, description, payout_request_id)
        VALUES (?,?,?,?,?,?,?)`)
        .run(org.id, 'withdrawal', amount, withdrawalFee, netPayout, `Payout request #${reqId}`, reqId);

      return reqId;
    })();

    logAudit(req.user.id, 'fleet.wallet.payout_requested', 'fleet_payout_requests', requestId, { amount, withdrawalFee, netPayout }, req.ip);
    res.json({ ok: true, payout_request_id: requestId, amount, withdrawal_fee: withdrawalFee, net_payout: netPayout });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /fleet/bank-details — get org bank account details
router.get('/bank-details', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    res.json({
      bank_account_name: org.bank_account_name || '',
      bank_name: org.bank_name || '',
      bank_account_number: org.bank_account_number || '',
      bank_branch_code: org.bank_branch_code || ''
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PUT /fleet/bank-details — save org bank account details
router.put('/bank-details', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const { bank_account_name, bank_name, bank_account_number, bank_branch_code } = req.body;
    db.prepare(`UPDATE organizations SET bank_account_name = ?, bank_name = ?, bank_account_number = ?, bank_branch_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(bank_account_name || null, bank_name || null, bank_account_number || null, bank_branch_code || null, org.id);
    logAudit(req.user.id, 'fleet.bank_details.updated', 'organizations', org.id, {}, req.ip);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /fleet/riders/:id/subscription — get a rider's current subscription status
router.get('/riders/:id/subscription', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const sub = db.prepare(`SELECT * FROM rider_subscriptions WHERE rider_user_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(toInt(req.params.id), org.id);
    res.json({ subscription: sub || null });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// POST /fleet/riders/:id/subscription/init — create Paystack subscription checkout for a rider
router.post('/riders/:id/subscription/init', companyRoleAllowed(FLEET_RESOURCE_ACCESS.riders.manage), async (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const rider = getScopedRider(org, toInt(req.params.id));
    if (!rider) return res.status(404).json({ error: 'Rider not found' });

    const agreement = db.prepare(`SELECT a.* FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      WHERE a.user_id = ? AND a.status IN ('active','paused')
        AND (b.organization_id = ? OR LOWER(TRIM(COALESCE(b.fleet,''))) IN (?,?))
      ORDER BY a.created_at DESC LIMIT 1`)
      .get(rider.id, org.id, String(org.name || '').toLowerCase().trim(), String(org.slug || '').toLowerCase().trim());

    if (!agreement) return res.status(400).json({ error: 'Rider has no active agreement' });

    const overrideAmount = req.body.plan_amount ? Math.round(Number(req.body.plan_amount)) : null;
    const weeklyAmount = overrideAmount || Math.round(Number(agreement.weekly_amount));

    const planCode = getRiderPlanCode(weeklyAmount);
    if (!planCode) {
      return res.status(400).json({
        error: `No payment plan configured for R${weeklyAmount}/week. Available amounts: R${RIDER_PLAN_AMOUNTS.join(', R')}.`
      });
    }

    const existingSub = db.prepare(`SELECT * FROM rider_subscriptions WHERE rider_user_id = ? AND organization_id = ? AND status = 'active'`)
      .get(rider.id, org.id);
    if (existingSub) return res.status(400).json({ error: 'Rider already has an active payment subscription' });

    const reference = `RSUB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email: rider.email,
      amount: weeklyAmount * 100,
      currency: 'ZAR',
      reference,
      plan: planCode,
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      metadata: {
        type: 'rider_subscription',
        organization_id: org.id,
        rider_user_id: rider.id,
        agreement_id: agreement.id,
        weekly_amount: weeklyAmount
      }
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

    db.prepare(`INSERT INTO rider_subscriptions (organization_id, rider_user_id, agreement_id, plan_code, weekly_amount, status) VALUES (?,?,?,?,?, 'pending')`)
      .run(org.id, rider.id, agreement.id, planCode, weeklyAmount);

    logAudit(req.user.id, 'fleet.rider.subscription_init', 'rider_subscriptions', rider.id, { plan_code: planCode, weekly_amount: agreement.weekly_amount }, req.ip);
    res.json({
      authorization_url: resp.data.data.authorization_url,
      access_code: resp.data.data.access_code,
      reference,
      plan_code: planCode,
      weekly_amount: agreement.weekly_amount,
      rider_name: rider.full_name,
      rider_email: rider.email
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.response?.data?.message || error.message });
  }
});

// POST /fleet/billing/cancel — cancel active subscription
router.post('/billing/cancel', companyRoleAllowed(FLEET_RESOURCE_ACCESS.billing.manage), async (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    if (org.status !== 'active') return res.status(400).json({ error: 'No active subscription to cancel' });

    if (org.paystack_subscription_code) {
      try {
        await cancelPaystackSubscription(org.paystack_subscription_code);
      } catch (e) {
        console.error(`[billing/cancel] Paystack cancel failed for ${org.paystack_subscription_code}:`, e.message);
        // Still cancel in DB even if Paystack call fails — admin can handle edge case
      }
    }

    db.prepare("UPDATE organizations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(org.id);
    logAudit(req.user.id, 'fleet_owner.billing.cancelled', 'organizations', org.id, { subscription_code: org.paystack_subscription_code }, req.ip);
    res.json({ ok: true, note: 'Subscription cancelled. You will not be charged again.' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not cancel subscription' });
  }
});

// ─── Hubs ─────────────────────────────────────────────────────────────────────

router.get('/hubs', companyRoleAllowed(FLEET_RESOURCE_ACCESS.hubs.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const hubs = db.prepare(`SELECT * FROM hubs WHERE organization_id = ? ORDER BY name ASC`).all(org.id);
    res.json({ hubs });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load hubs' });
  }
});

router.post('/hubs', companyRoleAllowed(FLEET_RESOURCE_ACCESS.hubs.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Hub name is required' });
    const info = db.prepare(`INSERT INTO hubs (organization_id, name, address, city, contact_name, contact_phone, notes) VALUES (?,?,?,?,?,?,?)`)
      .run(org.id, name, String(req.body.address || '').trim() || null, String(req.body.city || '').trim() || null, String(req.body.contact_name || '').trim() || null, String(req.body.contact_phone || '').trim() || null, String(req.body.notes || '').trim() || null);
    logAudit(req.user.id, 'fleet_owner.hub_create', 'hubs', info.lastInsertRowid, { organization_id: org.id }, req.ip);
    res.status(201).json({ ok: true, hub: db.prepare(`SELECT * FROM hubs WHERE id = ?`).get(info.lastInsertRowid) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create hub' });
  }
});

router.put('/hubs/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.hubs.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const hubId = toInt(req.params.id);
    if (!hubId) return res.status(400).json({ error: 'Invalid hub id' });
    const hub = db.prepare(`SELECT * FROM hubs WHERE id = ? AND organization_id = ?`).get(hubId, org.id);
    if (!hub) return res.status(404).json({ error: 'Hub not found' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Hub name is required' });
    db.prepare(`UPDATE hubs SET name = ?, address = ?, city = ?, contact_name = ?, contact_phone = ?, notes = ? WHERE id = ?`)
      .run(name, String(req.body.address || '').trim() || null, String(req.body.city || '').trim() || null, String(req.body.contact_name || '').trim() || null, String(req.body.contact_phone || '').trim() || null, String(req.body.notes || '').trim() || null, hubId);
    logAudit(req.user.id, 'fleet_owner.hub_update', 'hubs', hubId, { organization_id: org.id }, req.ip);
    res.json({ ok: true, hub: db.prepare(`SELECT * FROM hubs WHERE id = ?`).get(hubId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update hub' });
  }
});

router.delete('/hubs/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.hubs.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const hubId = toInt(req.params.id);
    if (!hubId) return res.status(400).json({ error: 'Invalid hub id' });
    const hub = db.prepare(`SELECT * FROM hubs WHERE id = ? AND organization_id = ?`).get(hubId, org.id);
    if (!hub) return res.status(404).json({ error: 'Hub not found' });
    const assigned = db.prepare(`SELECT COUNT(*) AS c FROM bikes WHERE hub_id = ?`).get(hubId);
    if (assigned.c > 0) return res.status(400).json({ error: 'Cannot delete hub with bikes assigned. Reassign bikes first.' });
    db.prepare(`DELETE FROM hubs WHERE id = ?`).run(hubId);
    logAudit(req.user.id, 'fleet_owner.hub_delete', 'hubs', hubId, { organization_id: org.id }, req.ip);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not delete hub' });
  }
});

// ─── Collections ──────────────────────────────────────────────────────────────

router.get('/collections', companyRoleAllowed(FLEET_RESOURCE_ACCESS.collections.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const scope = getBikeScope(org, 'b');
    const items = db.prepare(`SELECT a.id, a.agreement_no, a.status, a.weekly_amount, a.start_date,
        u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
        b.registration AS bike_registration, b.make, b.model,
        td.id AS tracking_device_id, td.model AS device_model, td.connected AS device_connected,
        COALESCE((
          SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
          FROM payment_schedules ps
          WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
        ), 0) AS overdue_balance,
        (
          SELECT ca.stage FROM collections_actions ca
          WHERE ca.agreement_id = a.id AND ca.organization_id = ?
          ORDER BY ca.created_at DESC, ca.id DESC LIMIT 1
        ) AS current_stage,
        (
          SELECT MIN(ps2.due_date) FROM payment_schedules ps2
          WHERE ps2.agreement_id = a.id AND ps2.status = 'overdue'
        ) AS first_overdue_date
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN tracking_devices td ON td.bike_id = b.id
      WHERE (a.status = 'defaulted' OR EXISTS(
        SELECT 1 FROM payment_schedules ps WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
      )) AND ${scope.clause}
      ORDER BY overdue_balance DESC, a.id DESC`).all(org.id, ...scope.params);

    const today = todayIso();
    const result = items.map((item) => ({
      ...item,
      current_stage: item.current_stage || 'pending',
      days_overdue: item.first_overdue_date ? Math.max(0, Math.floor((new Date(today) - new Date(item.first_overdue_date)) / 86400000)) : 0
    }));
    res.json({ collections: result });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load collections' });
  }
});

router.post('/collections/:agreementId/action', companyRoleAllowed(FLEET_RESOURCE_ACCESS.collections.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.agreementId);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });

    const agreement = getScopedAgreement(org, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

    const stage = String(req.body.stage || '').trim();
    const action_type = String(req.body.action_type || '').trim();
    const validStages = ['pending', 'contacted', 'notice_sent', 'recovery', 'resolved'];
    const validTypes = ['call', 'sms', 'whatsapp', 'email', 'visit', 'legal_notice', 'repo', 'note'];

    if (!validStages.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
    if (!validTypes.includes(action_type)) return res.status(400).json({ error: 'Invalid action type' });

    const info = db.prepare(`INSERT INTO collections_actions (agreement_id, organization_id, stage, action_type, notes, outcome, next_action_date, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(
        agreementId, org.id, stage, action_type,
        String(req.body.notes || '').trim() || null,
        String(req.body.outcome || '').trim() || null,
        String(req.body.next_action_date || '').trim() || null,
        req.user.id
      );

    logAudit(req.user.id, 'fleet_owner.collections_action', 'collections_actions', info.lastInsertRowid, { agreement_id: agreementId, stage, action_type }, req.ip);
    const action = db.prepare(`SELECT ca.*, u.full_name AS created_by_name FROM collections_actions ca JOIN users u ON u.id = ca.created_by WHERE ca.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ ok: true, action });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not log collections action' });
  }
});

router.get('/collections/:agreementId/actions', companyRoleAllowed(FLEET_RESOURCE_ACCESS.collections.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.agreementId);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });
    const agreement = getScopedAgreement(org, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    const actions = db.prepare(`SELECT ca.*, u.full_name AS created_by_name FROM collections_actions ca JOIN users u ON u.id = ca.created_by WHERE ca.agreement_id = ? AND ca.organization_id = ? ORDER BY ca.created_at DESC, ca.id DESC`).all(agreementId, org.id);
    res.json({ actions });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load actions' });
  }
});

// ─── API Keys ─────────────────────────────────────────────────────────────────

router.get('/api-keys', companyRoleAllowed(FLEET_RESOURCE_ACCESS.api_keys.view), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const keys = db.prepare(`SELECT ak.id, ak.name, ak.key_prefix, ak.last_used_at, ak.revoked_at, ak.created_at, u.full_name AS created_by_name
      FROM api_keys ak LEFT JOIN users u ON u.id = ak.created_by
      WHERE ak.organization_id = ? ORDER BY ak.created_at DESC`).all(org.id);
    res.json({ api_keys: keys });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load API keys' });
  }
});

router.post('/api-keys', companyRoleAllowed(FLEET_RESOURCE_ACCESS.api_keys.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Key name is required' });
    const rawKey = `onfleet_${crypto.randomBytes(32).toString('hex')}`;
    const prefix = rawKey.slice(0, 16);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const info = db.prepare(`INSERT INTO api_keys (organization_id, created_by, name, key_hash, key_prefix) VALUES (?,?,?,?,?)`)
      .run(org.id, req.user.id, name, keyHash, prefix);
    logAudit(req.user.id, 'fleet_owner.api_key_create', 'api_keys', info.lastInsertRowid, { organization_id: org.id, name }, req.ip);
    res.status(201).json({ ok: true, key: rawKey, key_id: info.lastInsertRowid, prefix, name });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create API key' });
  }
});

router.delete('/api-keys/:id', companyRoleAllowed(FLEET_RESOURCE_ACCESS.api_keys.manage), (req, res) => {
  try {
    const org = getOrganizationOrThrow(req.user.organization_id, { allowExpired: true });
    const keyId = toInt(req.params.id);
    if (!keyId) return res.status(400).json({ error: 'Invalid key id' });
    const key = db.prepare(`SELECT * FROM api_keys WHERE id = ? AND organization_id = ? AND revoked_at IS NULL`).get(keyId, org.id);
    if (!key) return res.status(404).json({ error: 'API key not found or already revoked' });
    db.prepare(`UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(keyId);
    logAudit(req.user.id, 'fleet_owner.api_key_revoke', 'api_keys', keyId, { organization_id: org.id }, req.ip);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not revoke API key' });
  }
});

// ─── Fleet Tracking (GPS) ────────────────────────────────────────────────────

const teltonikaServer = require('../tcp/teltonikaServer');
const trackingEvents  = require('../trackingEvents');

const FLEET_ENGINE_CUT  = { FMB920: 'setdigout 1 1', FMC920: 'setdigout 1 1', FMB965: 'setdigout 2 1', other: 'setdigout 1 1' };
const FLEET_ENGINE_REST = { FMB920: 'setdigout 1 0', FMC920: 'setdigout 1 0', FMB965: 'setdigout 2 0', other: 'setdigout 1 0' };
const FLEET_TRACKING_PRESETS = {
  cut_engine:     (model) => FLEET_ENGINE_CUT[model]  || FLEET_ENGINE_CUT.other,
  restore_engine: (model) => FLEET_ENGINE_REST[model] || FLEET_ENGINE_REST.other,
  get_info:   () => 'getinfo',
  get_status: () => 'getstatus',
};

function getOrgBikeIds(organizationId) {
  return db.prepare(`SELECT id FROM bikes WHERE organization_id = ?`).all(organizationId).map(r => r.id);
}

// GET /fleet/tracking/map
router.get('/tracking/map', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const connected = teltonikaServer.getConnectedIMEIs();
  const devices = db.prepare(`
    SELECT td.id, td.imei, td.model, td.label, td.last_seen_at, td.speed_limit_kmh,
           b.id AS bike_id, b.registration, b.make, b.model AS bike_model, b.status AS bike_status,
           b.color AS bike_color, b.vin AS bike_vin, b.year AS bike_year,
           b.last_known_lat AS lat, b.last_known_lng AS lng, b.last_location_at,
           b.odometer_km,
           gp.speed_kmh, gp.heading, gp.ignition, gp.satellites, gp.altitude, gp.io_data,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone
    FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id AND b.organization_id = ?
    LEFT JOIN gps_pings gp ON gp.id = (
      SELECT id FROM gps_pings WHERE bike_id = b.id ORDER BY recorded_at DESC LIMIT 1
    )
    ORDER BY td.last_seen_at DESC
  `).all(orgId);
  for (const d of devices) d.connected = connected.includes(d.imei) ? 1 : 0;
  res.json(devices);
});

// GET /fleet/tracking/devices
router.get('/tracking/devices', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const connected = teltonikaServer.getConnectedIMEIs();
  const devices = db.prepare(`
    SELECT td.*, b.registration, b.make, b.model AS bike_model, b.color AS bike_color,
           b.last_known_lat, b.last_known_lng, b.last_location_at,
           (SELECT u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_name,
           (SELECT u.phone    FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.bike_id = b.id AND a.status = 'active' ORDER BY a.created_at DESC LIMIT 1) AS rider_phone
    FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id AND b.organization_id = ?
    ORDER BY td.connected DESC, td.last_seen_at DESC
  `).all(orgId);
  for (const d of devices) d.connected = connected.includes(d.imei) ? 1 : 0;
  res.json(devices);
});

// GET /fleet/tracking/devices/:id/positions
router.get('/tracking/devices/:id/positions', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const device = db.prepare(`
    SELECT td.*, b.organization_id FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id WHERE td.id = ?`).get(req.params.id);
  if (!device || device.organization_id !== orgId) return res.status(404).json({ error: 'Device not found' });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const from = req.query.from || null;
  const to = req.query.to || null;
  let sql = `SELECT id, lat, lng, speed_kmh, heading, recorded_at, satellites, altitude, ignition FROM gps_pings WHERE bike_id = ?`;
  const params = [device.bike_id];
  if (from) { sql += ' AND recorded_at >= ?'; params.push(from); }
  if (to) { sql += ' AND recorded_at <= ?'; params.push(to); }
  sql += ' ORDER BY recorded_at DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params).reverse());
});

// POST /fleet/tracking/devices/:id/commands
router.post('/tracking/devices/:id/commands', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.manage), async (req, res) => {
  const orgId = req.user.organization_id;
  const device = db.prepare(`
    SELECT td.*, b.organization_id FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id WHERE td.id = ?`).get(req.params.id);
  if (!device || device.organization_id !== orgId) return res.status(404).json({ error: 'Device not found' });

  const { preset } = req.body;
  if (!preset) return res.status(400).json({ error: 'Provide a preset command' });
  const fn = FLEET_TRACKING_PRESETS[preset];
  if (!fn) return res.status(400).json({ error: `Unknown preset. Available: ${Object.keys(FLEET_TRACKING_PRESETS).join(', ')}` });

  const command = fn(device.model);
  const info = db.prepare(`INSERT INTO tracking_commands (device_id, command, created_by) VALUES (?,?,?)`).run(device.id, command, req.user.id);
  const sentNow = teltonikaServer.sendCommand(device.imei, info.lastInsertRowid, command);

  logAudit(req.user.id, `fleet_tracking.${preset}`, 'tracking_devices', device.id, { preset, bike_id: device.bike_id }, req.ip);

  res.json({
    id: info.lastInsertRowid,
    command,
    status: sentNow ? 'sent' : 'pending',
    note: sentNow ? 'Command sent to device' : 'Device offline — command queued for when it reconnects'
  });
});

// GET /fleet/tracking/devices/:id/commands
router.get('/tracking/devices/:id/commands', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const device = db.prepare(`
    SELECT td.id, b.organization_id FROM tracking_devices td
    JOIN bikes b ON b.id = td.bike_id WHERE td.id = ?`).get(req.params.id);
  if (!device || device.organization_id !== orgId) return res.status(404).json({ error: 'Device not found' });
  const commands = db.prepare(
    `SELECT tc.*, u.full_name AS created_by_name FROM tracking_commands tc
     LEFT JOIN users u ON u.id = tc.created_by
     WHERE tc.device_id = ? ORDER BY tc.created_at DESC LIMIT 50`
  ).all(device.id);
  res.json(commands);
});

// GET /fleet/tracking/alerts
router.get('/tracking/alerts', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const unackedOnly = req.query.unacked === '1';
  let sql = `SELECT ta.*, b.registration AS bike_registration FROM tracking_alerts ta
    JOIN bikes b ON b.id = ta.bike_id AND b.organization_id = ? WHERE 1=1`;
  const params = [orgId];
  if (unackedOnly) sql += ' AND ta.acknowledged_at IS NULL';
  sql += ' ORDER BY ta.created_at DESC LIMIT ?';
  params.push(limit);
  res.json(db.prepare(sql).all(...params));
});

// PUT /fleet/tracking/alerts/:id/acknowledge
router.put('/tracking/alerts/:id/acknowledge', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.manage), (req, res) => {
  const orgId = req.user.organization_id;
  const alert = db.prepare(`SELECT ta.id FROM tracking_alerts ta JOIN bikes b ON b.id = ta.bike_id WHERE ta.id = ? AND b.organization_id = ?`).get(req.params.id, orgId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  db.prepare('UPDATE tracking_alerts SET acknowledged_at=CURRENT_TIMESTAMP WHERE id=?').run(alert.id);
  res.json({ ok: true });
});

// POST /fleet/tracking/alerts/acknowledge-all
router.post('/tracking/alerts/acknowledge-all', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.manage), (req, res) => {
  const orgId = req.user.organization_id;
  db.prepare(`UPDATE tracking_alerts SET acknowledged_at=CURRENT_TIMESTAMP
    WHERE acknowledged_at IS NULL AND bike_id IN (SELECT id FROM bikes WHERE organization_id = ?)`).run(orgId);
  res.json({ ok: true });
});

// GET /fleet/tracking/live — SSE stream filtered to org's bikes
router.get('/tracking/live', companyRoleAllowed(FLEET_RESOURCE_ACCESS.tracking.view), (req, res) => {
  const orgId = req.user.organization_id;
  const bikeIds = new Set(getOrgBikeIds(orgId));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const onPing = (payload) => {
    if (!bikeIds.has(payload.bike_id)) return;
    try { res.write(`event: ping\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };
  const onAlert = (payload) => {
    if (!bikeIds.has(payload.bike_id)) return;
    try { res.write(`event: alert\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };

  trackingEvents.on('ping', onPing);
  trackingEvents.on('alert', onAlert);
  const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch (_) {} }, 25_000);

  req.on('close', () => {
    trackingEvents.off('ping', onPing);
    trackingEvents.off('alert', onAlert);
    clearInterval(hb);
  });
});

module.exports = router;
