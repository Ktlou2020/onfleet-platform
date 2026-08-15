const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const pgDb = require('../pgDb');
const { authRequired } = require('../middleware/auth');
const { logAudit, addDays } = require('../utils/helpersPg');
const { extractPayslipInsights } = require('../services/documentInsights');
const { sendNotification } = require('../services/notifierPg');
const { requireValidMime } = require('../utils/validateUpload');
const asyncRouter = require('../utils/asyncRouter');
const { hybridStorage } = require('../utils/hybridStorage');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Try again in 15 minutes.' }
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Try again later.' }
});

const router = asyncRouter(express.Router());
const { applications: uploadDir, profiles: profileUploadDir } = require('../uploadPaths');
const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const FLEET_PLAN_ENTITLEMENTS = {
  trial:  { max_bikes: 6,    max_admin_users: 2 },
  small:  { max_bikes: 6,    max_admin_users: 2 },
  medium: { max_bikes: 20,   max_admin_users: 3 },
  large:  { max_bikes: 35,   max_admin_users: 5 },
  empire: { max_bikes: 9999, max_admin_users: 20 },
};

const signupUpload = multer({
  storage: hybridStorage(uploadDir, 'applications', (req, file) =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isPayslip = String(file.fieldname || '').startsWith('payslip_');
    const ok = isPayslip
      ? ['application/pdf', 'image/jpeg', 'image/jpg', 'image/pjpeg'].includes(file.mimetype)
      : ['application/pdf', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    const error = isPayslip
      ? 'Payslips must be uploaded as PDF, JPG, or JPEG files'
      : 'Only PDF, JPG, JPEG, PNG, and WEBP files are allowed';
    cb(ok ? null : new Error(error), ok);
  }
});

const profileUpload = multer({
  storage: hybridStorage(profileUploadDir, 'profiles', (req, file) =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname).toLowerCase()}`),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, JPEG, PNG, and WEBP images are allowed'), ok);
  }
});

function signToken(user) {
  return jwt.sign({ uid: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

function parsePlatforms(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return String(raw).split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function passwordResetExpiryIso() {
  const ttlMinutes = Number(readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60);
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildResetUrl(token) {
  const base = readEnv('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

async function slugifyCompanyName(value) {
  const base = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `fleet-${Date.now()}`;
  let slug = base;
  let counter = 2;
  while (true) {
    const { rows } = await pgDb.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (!rows[0]) break;
    slug = `${base}-${counter++}`;
  }
  return slug;
}

function getFleetEntitlements(planKey = 'trial') {
  return FLEET_PLAN_ENTITLEMENTS[planKey] || FLEET_PLAN_ENTITLEMENTS.trial;
}

async function getSafeUser(userId) {
  const { rows } = await pgDb.query(`SELECT u.id, u.email, u.full_name, u.role, u.organization_id,
    o.name organization_name, o.slug organization_slug, o.status organization_status, o.plan_key organization_plan_key
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE u.id = $1 AND u.deleted_at IS NULL`, [userId]);
  return rows[0];
}

function getRequiredFile(req, field) {
  return req.files?.[field]?.[0] || null;
}

function parseMoneyAmount(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return +amount.toFixed(2);
}

function isPayslipImageMime(mimeType) {
  return ['image/jpeg', 'image/jpg', 'image/pjpeg'].includes(String(mimeType || '').toLowerCase());
}

async function resolvePayslipInsights(file, manualAmountRaw) {
  const manualAmount = parseMoneyAmount(manualAmountRaw);

  if (file.mimetype === 'application/pdf') {
    const insights = await extractPayslipInsights(path.join(uploadDir, file.filename), file.mimetype);
    if (insights.extracted_amount || !manualAmount) return insights;
    return {
      extracted_amount: manualAmount,
      extracted_text: 'Manual amount entered for PDF payslip'
    };
  }

  if (isPayslipImageMime(file.mimetype)) {
    if (!manualAmount) {
      throw new Error(`Please enter the Rand amount for ${file.originalname} because JPEG payslips are captured manually`);
    }
    return {
      extracted_amount: manualAmount,
      extracted_text: 'Manual amount entered for JPEG payslip'
    };
  }

  throw new Error('Payslips must be uploaded as PDF, JPG, or JPEG files');
}

async function createApplication(userId, payload, db = pgDb) {
  const { rows } = await db.query(`INSERT INTO applications
    (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience,
     years_riding, has_drivers_license, payout_preference, bank_name, account_holder,
     account_number, branch_code, ewallet_number, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [
      userId,
      payload.preferred_bike_id || null,
      null,
      (payload.delivery_platforms || []).join(','),
      payload.has_riding_experience,
      payload.years_riding || null,
      payload.has_drivers_license,
      payload.payout_preference || null,
      payload.bank_name || null,
      payload.account_holder || null,
      payload.account_number || null,
      payload.branch_code || null,
      payload.ewallet_number || null,
      'submitted'
    ]);
  return rows[0].id;
}

async function insertApplicationDocument({ applicationId, userId, docType, file, extracted_amount = null, extracted_text = null }) {
  const publicFile = `/uploads/applications/${file.filename}`;
  await pgDb.query(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      applicationId,
      userId,
      docType,
      publicFile,
      file.originalname,
      file.mimetype,
      extracted_amount,
      extracted_text,
      userId
    ]);
}

async function insertKycDocument({ userId, docType, file }) {
  await pgDb.query(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name)
    VALUES ($1,$2,$3,$4)`, [userId, docType, `/uploads/applications/${file.filename}`, file.originalname]);
}

async function getPayslipSummary(applicationId) {
  const { rows: payslips } = await pgDb.query(`SELECT * FROM application_documents
    WHERE application_id = $1 AND doc_type = 'payslip' AND extracted_amount IS NOT NULL
    ORDER BY uploaded_at DESC LIMIT 3`, [applicationId]);
  const total = payslips.reduce((sum, row) => sum + Number(row.extracted_amount || 0), 0);
  const average = payslips.length ? +(total / payslips.length).toFixed(2) : 0;
  return { payslips, total: +total.toFixed(2), average };
}

async function recalcApplicationDecision(applicationId) {
  const { rows: applicationRows } = await pgDb.query(`SELECT a.*, u.full_name, u.email
    FROM applications a JOIN users u ON u.id = a.user_id WHERE a.id = $1`, [applicationId]);
  const application = applicationRows[0];
  if (!application) return null;

  const { payslips, total, average } = await getPayslipSummary(applicationId);
  await pgDb.query(`UPDATE applications SET total_paid_last_3 = $1, average_weekly_earnings = $2 WHERE id = $3`,
    [total, average, applicationId]);

  if (payslips.length < 3) return { total, average, decision: 'insufficient_documents' };

  if (average < 1000) {
    const retryAfter = addDays(new Date().toISOString().slice(0, 10), 14);
    await pgDb.query(`UPDATE applications
      SET status = 'rejected', auto_decision = 'auto_declined', rejection_reason = $1, retry_after_date = $2, reviewed_at = NOW()
      WHERE id = $3`,
      [
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

router.post('/signup',
  signupLimiter,
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('full_name').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, full_name, phone, id_number, address, city, province, postal_code,
            date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin } = req.body;

    const { rows: existingRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [normalizeEmail(email)]);
    if (existingRows[0]) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const { rows: insertedRows } = await pgDb.query(`INSERT INTO users
      (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
       date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin, role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, 'rider') RETURNING id`,
      [
        normalizeEmail(email), hash, full_name, phone || null, id_number || null,
        address || null, city || null, province || null, postal_code || null,
        date_of_birth || null, emergency_contact_name || null, emergency_contact_phone || null, country_of_origin || null
      ]);

    const { rows: userRows } = await pgDb.query('SELECT id, email, full_name, role FROM users WHERE id = $1', [insertedRows[0].id]);
    const user = userRows[0];
    await logAudit(user.id, 'user.signup', 'users', user.id, { email }, req.ip);
    res.json({ token: signToken(user), user });
  });

const SIGNUP_FIELDS = [
  { name: 'id_document', maxCount: 1 },
  { name: 'drivers_license', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'payslip_1', maxCount: 1 },
  { name: 'payslip_2', maxCount: 1 },
  { name: 'payslip_3', maxCount: 1 }
];

function handleSignupUpload(req, res, next) {
  signupUpload.fields(SIGNUP_FIELDS)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'One or more files are too large. Each file must be under 10 MB. Please compress the file and try again.' });
    }
    return res.status(400).json({ error: err.message || 'File upload failed. Please check your files and try again.' });
  });
}

router.post('/signup-complete', handleSignupUpload, async (req, res) => {
  try {
    const {
      email, password, full_name, phone, id_number, address, city, province, postal_code,
      date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin,
      preferred_bike_id, years_riding, payout_preference,
      bank_name, account_holder, account_number, branch_code, ewallet_number
    } = req.body;

    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Please enter your email address.' });
    if (!phone || !phone.trim()) return res.status(400).json({ error: 'Please enter your phone or WhatsApp number.' });
    if (!id_number || !id_number.trim()) return res.status(400).json({ error: 'Please enter your ID number, passport number, or asylum number.' });
    if (!password) return res.status(400).json({ error: 'Please create a password.' });
    if (password.length < 6) return res.status(400).json({ error: 'Your password must be at least 6 characters long.' });
    if (!preferred_bike_id) return res.status(400).json({ error: 'Please choose your preferred bike.' });

    const platforms = parsePlatforms(req.body.delivery_platforms);
    if (!platforms.length) return res.status(400).json({ error: 'Please select at least one delivery platform.' });

    const requiredFiles = ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3'];
    const fileLabels = { id_document: 'ID document', drivers_license: "Driver's licence", selfie: 'Selfie holding your ID', payslip_1: 'Payslip 1', payslip_2: 'Payslip 2', payslip_3: 'Payslip 3' };
    for (const field of requiredFiles) {
      if (!getRequiredFile(req, field)) return res.status(400).json({ error: `Please upload your ${fileLabels[field]}.` });
    }

    for (let index = 0; index < 3; index++) {
      const field = `payslip_${index + 1}`;
      const file = getRequiredFile(req, field);
      if (file && isPayslipImageMime(file.mimetype) && !parseMoneyAmount(req.body[`payslip_amount_${index + 1}`])) {
        return res.status(400).json({ error: `Please type the Rand amount shown on Payslip ${index + 1}. JPEG payslips cannot be read automatically — you must enter the amount manually.` });
      }
    }

    if (payout_preference === 'eft') {
      if (!bank_name) return res.status(400).json({ error: 'Please enter your bank name.' });
      if (!account_holder) return res.status(400).json({ error: 'Please enter the bank account holder name.' });
      if (!account_number) return res.status(400).json({ error: 'Please enter your bank account number.' });
      if (!branch_code) return res.status(400).json({ error: 'Please enter your bank branch code.' });
    }
    if (payout_preference === 'ewallet' && !ewallet_number) {
      return res.status(400).json({ error: 'Please enter your e-wallet cellphone number.' });
    }

    const { rows: existingRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [normalizeEmail(email)]);
    if (existingRows[0]) return res.status(409).json({ error: 'This email address is already registered. Please sign in or use a different email address.' });

    const payload = {
      preferred_bike_id: Number(preferred_bike_id),
      delivery_platforms: platforms,
      has_riding_experience: toBool(req.body.has_riding_experience, true),
      years_riding: years_riding ? Number(years_riding) : null,
      has_drivers_license: toBool(req.body.has_drivers_license, true),
      payout_preference,
      bank_name: bank_name || null,
      account_holder: account_holder || null,
      account_number: account_number || null,
      branch_code: branch_code || null,
      ewallet_number: ewallet_number || null
    };

    const hash = await bcrypt.hash(password, 10);
    const created = await pgDb.withTransaction(async (client) => {
      const { rows: userRows } = await client.query(`INSERT INTO users
        (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
         date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin, role)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, 'rider') RETURNING id`,
        [
          normalizeEmail(email), hash, full_name, phone || null, id_number || null,
          address || null, city || null, province || null, postal_code || null,
          date_of_birth || null, emergency_contact_name || null, emergency_contact_phone || null, country_of_origin || null
        ]);
      const userId = userRows[0].id;
      const applicationId = await createApplication(userId, payload, client);
      return { userId, applicationId };
    });

    const idDocument = getRequiredFile(req, 'id_document');
    const driversLicense = getRequiredFile(req, 'drivers_license');
    const selfie = getRequiredFile(req, 'selfie');
    const payslipFiles = ['payslip_1', 'payslip_2', 'payslip_3'].map((field) => getRequiredFile(req, field)).filter(Boolean);

    await insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'id_document', file: idDocument });
    await insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'drivers_license', file: driversLicense });
    await insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'other', file: selfie });

    await insertKycDocument({ userId: created.userId, docType: 'id_document', file: idDocument });
    await insertKycDocument({ userId: created.userId, docType: 'drivers_license', file: driversLicense });
    await insertKycDocument({ userId: created.userId, docType: 'selfie', file: selfie });

    const payslipInsights = await Promise.all(
      payslipFiles.map((payslip, index) => resolvePayslipInsights(payslip, req.body[`payslip_amount_${index + 1}`]))
    );

    for (let i = 0; i < payslipFiles.length; i++) {
      await insertApplicationDocument({
        applicationId: created.applicationId,
        userId: created.userId,
        docType: 'payslip',
        file: payslipFiles[i],
        extracted_amount: payslipInsights[i].extracted_amount || null,
        extracted_text: payslipInsights[i].extracted_text || null
      });
    }

    const decision = await recalcApplicationDecision(created.applicationId);
    const { rows: userRows } = await pgDb.query('SELECT id, email, full_name, role FROM users WHERE id = $1', [created.userId]);
    const user = userRows[0];
    await logAudit(user.id, 'user.signup_complete', 'users', user.id, { application_id: created.applicationId }, req.ip);

    res.json({ token: signToken(user), user, application_id: created.applicationId, decision });
  } catch (error) {
    if (error.code === '23505') {
      const isEmail = String(error.constraint || '').includes('email') || String(error.detail || '').toLowerCase().includes('email');
      return res.status(409).json({ error: isEmail
        ? 'This email address is already registered. Please sign in or use a different email address.'
        : 'An account with some of these details already exists. Please check your information and try again.' });
    }
    res.status(400).json({ error: error.message || 'Sign up could not be completed. Please check all your details and try again.' });
  }
});

router.post('/fleet/signup',
  signupLimiter,
  body('company_name').notEmpty(),
  body('full_name').notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const company_name = String(req.body.company_name || '').trim();
    const full_name = String(req.body.full_name || '').trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const phone = String(req.body.phone || '').trim();
    const city = String(req.body.city || '').trim();
    const fleet_size = Math.max(0, Number(req.body.fleet_size || 0) || 0);
    const requestedPlan = String(req.body.plan_interest || 'trial').trim().toLowerCase();
    const requestedRole = String(req.body.role || 'fleet_owner_admin').trim();
    const planKey = Object.keys(FLEET_PLAN_ENTITLEMENTS).includes(requestedPlan) ? requestedPlan : 'trial';

    if (!company_name || !full_name) return res.status(400).json({ error: 'Company name and full name are required' });
    const { rows: existingRows } = await pgDb.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
    if (existingRows[0]) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (!FLEET_ROLE_VALUES.includes(requestedRole)) {
      return res.status(400).json({ error: 'Invalid fleet-owner role' });
    }

    const entitlements = getFleetEntitlements(planKey);
    const hash = await bcrypt.hash(password, 10);
    const now = new Date();
    const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const slug = await slugifyCompanyName(company_name);

    const created = await pgDb.withTransaction(async (client) => {
      const { rows: orgRows } = await client.query(`INSERT INTO organizations
        (name, slug, contact_email, contact_phone, city, fleet_size, plan_key, status, trial_started_at, trial_ends_at, max_bikes, max_admin_users)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'trialing',$8,$9,$10,$11) RETURNING id`,
        [
          company_name,
          slug,
          email,
          phone || null,
          city || null,
          fleet_size,
          planKey,
          now.toISOString(),
          trialEnds.toISOString(),
          entitlements.max_bikes,
          entitlements.max_admin_users
        ]);
      const organizationId = orgRows[0].id;

      const { rows: userRows } = await client.query(`INSERT INTO users
          (email, password_hash, full_name, phone, city, role, organization_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7, 'active') RETURNING id`,
        [
          email,
          hash,
          full_name,
          phone || null,
          city || null,
          requestedRole,
          organizationId
        ]);

      return { organizationId, userId: userRows[0].id };
    });

    const user = await getSafeUser(created.userId);
    await logAudit(user.id, 'fleet_owner.signup', 'organizations', created.organizationId, { company_name, role: requestedRole, plan: planKey }, req.ip);
    res.json({ token: signToken(user), user });
  });

router.post('/login',
  loginLimiter,
  body('email').isEmail(),
  body('password').notEmpty(),
  async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    const { rows: userRows } = await pgDb.query('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
    if (!user.password_hash || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    await logAudit(user.id, 'user.login', 'users', user.id, {}, req.ip);
    const safe = await getSafeUser(user.id) || { id: user.id, email: user.email, full_name: user.full_name, role: user.role, organization_id: user.organization_id || null };
    res.json({ token: signToken(safe), user: safe });
  });

router.post('/forgot-password',
  passwordResetLimiter,
  body('email').isEmail(),
  async (req, res) => {
    try {
      const email = normalizeEmail(req.body.email);
      const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
      const { rows: userRows } = await pgDb.query(`SELECT id, email, full_name, status FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
      const user = userRows[0];

      if (!user || user.status !== 'active') return res.json(generic);

      // Cooldown: max one reset request per 5 minutes per user
      const { rows: recentTokenRows } = await pgDb.query(
        `SELECT created_at FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      if (recentTokenRows[0]) return res.json(generic); // silently honour cooldown

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      await pgDb.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await pgDb.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
        VALUES ($1,$2,$3,$4,$5)`, [user.id, tokenHash, passwordResetExpiryIso(), req.ip || null, req.get('user-agent') || null]);

      const firstName = user.full_name?.split(' ')?.[0] || 'there';
      const resetUrl = buildResetUrl(rawToken);
      sendNotification({
        userId: user.id,
        channel: 'email',
        type: 'password_reset',
        title: 'Reset your OnFleet password',
        message: `Hi ${firstName},\n\nWe received a request to reset your OnFleet password.\n\nReset link: ${resetUrl}\n\nThis link expires in ${readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60} minutes. If you did not request this, you can ignore this email.\n\nKind Regards\nOnFleet Team`
      }).catch((emailErr) => console.error('[forgot-password] email delivery failed:', emailErr.message));

      await logAudit(user.id, 'user.password_reset_requested', 'users', user.id, {}, req.ip);
      return res.json(generic);
    } catch (err) {
      console.error('[forgot-password]', err.message);
      return res.status(500).json({ error: 'Could not process password reset request' });
    }
  });

router.post('/reset-password',
  passwordResetLimiter,
  body('token').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  async (req, res) => {
    const tokenHash = hashResetToken(req.body.token);
    const { rows: tokenRows } = await pgDb.query(`SELECT prt.id, prt.user_id, u.email
      FROM password_reset_tokens prt
      JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = $1
        AND prt.used_at IS NULL
        AND prt.expires_at > NOW()
        AND u.deleted_at IS NULL`, [tokenHash]);
    const tokenRow = tokenRows[0];

    if (!tokenRow) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const passwordHash = await bcrypt.hash(req.body.new_password, 10);
    await pgDb.withTransaction(async (client) => {
      await client.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [passwordHash, tokenRow.user_id]);
      await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [tokenRow.user_id]);
    });

    await logAudit(tokenRow.user_id, 'user.password_reset_completed', 'users', tokenRow.user_id, {}, req.ip);
    res.json({ ok: true, message: 'Password reset successful. You can now sign in.' });
  });

router.get('/me', authRequired, async (req, res) => {
  const { rows } = await pgDb.query(`SELECT u.id, u.email, u.full_name, u.phone, u.role, u.status, u.organization_id,
                        u.id_number, u.date_of_birth, u.address, u.city, u.province, u.postal_code,
                        u.emergency_contact_name, u.emergency_contact_phone, u.avatar_url,
                        u.country_of_origin, u.created_at,
                        o.name organization_name, o.slug organization_slug, o.status organization_status,
                        o.plan_key organization_plan_key, o.trial_started_at organization_trial_started_at,
                        o.trial_ends_at organization_trial_ends_at
                        FROM users u
                        LEFT JOIN organizations o ON o.id = u.organization_id
                        WHERE u.id = $1 AND u.deleted_at IS NULL`, [req.user.id]);
  res.json({ user: rows[0] });
});

router.put('/me', authRequired, async (req, res) => {
  const fields = ['full_name','phone','id_number','date_of_birth','address','city','province',
                  'postal_code','emergency_contact_name','emergency_contact_phone','avatar_url','country_of_origin'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(f); values.push(req.body[f]); }
  }
  if (!updates.length) return res.json({ ok: true });
  const setClause = updates.map((col, i) => `${col} = $${i + 1}`).join(', ');
  values.push(req.user.id);
  await pgDb.query(`UPDATE users SET ${setClause}, updated_at = NOW() WHERE id = $${values.length}`, values);
  res.json({ ok: true });
});

router.post('/me/selfie', authRequired, profileUpload.single('selfie'), requireValidMime(['image/jpeg', 'image/png', 'image/webp']), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Selfie image is required' });
  const avatarUrl = `/uploads/profiles/${req.file.filename}`;
  await pgDb.query(`UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2`, [avatarUrl, req.user.id]);
  const { rows: existingRows } = await pgDb.query(`SELECT id FROM kyc_documents WHERE user_id = $1 AND doc_type = 'selfie'`, [req.user.id]);
  if (existingRows[0]) {
    await pgDb.query(`UPDATE kyc_documents SET file_path = $1, original_name = $2, uploaded_at = NOW() WHERE id = $3`,
      [avatarUrl, req.file.originalname, existingRows[0].id]);
  } else {
    await pgDb.query(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
      VALUES ($1, 'selfie', $2, $3, 'approved')`, [req.user.id, avatarUrl, req.file.originalname]);
  }
  res.json({ ok: true, avatar_url: avatarUrl });
});

router.post('/change-password', authRequired,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { rows: userRows } = await pgDb.query('SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL', [req.user.id]);
    const u = userRows[0];
    if (!u) return res.status(403).json({ error: 'User not found' });
    if (!await bcrypt.compare(req.body.current_password, u.password_hash)) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hash = await bcrypt.hash(req.body.new_password, 10);
    await pgDb.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ ok: true });
  });

module.exports = router;
