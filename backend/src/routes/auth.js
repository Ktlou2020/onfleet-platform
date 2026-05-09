const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const { authRequired } = require('../middleware/auth');
const { logAudit, addDays } = require('../utils/helpers');
const { extractPayslipInsights } = require('../services/documentInsights');
const { sendNotification } = require('../services/notifier');

const router = express.Router();
const uploadDir = path.join(__dirname, '../../uploads/applications');
const profileUploadDir = path.join(__dirname, '../../uploads/profiles');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(profileUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
  }
});

const signupUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF, JPG, JPEG, and PNG files are allowed'), ok);
  }
});

const profileUpload = multer({
  storage: multer.diskStorage({
    destination: profileUploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only JPG, PNG, and WEBP images are allowed'), ok);
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
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildResetUrl(token) {
  const base = readEnv('FRONTEND_URL', 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

function getRequiredFile(req, field) {
  return req.files?.[field]?.[0] || null;
}

function createApplication(userId, payload) {
  const info = db.prepare(`INSERT INTO applications
    (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience,
     years_riding, has_drivers_license, payout_preference, bank_name, account_holder,
     account_number, branch_code, ewallet_number, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      userId,
      payload.preferred_bike_id || null,
      payload.monthly_income || null,
      (payload.delivery_platforms || []).join(','),
      payload.has_riding_experience ? 1 : 0,
      payload.years_riding || null,
      payload.has_drivers_license ? 1 : 0,
      payload.payout_preference || null,
      payload.bank_name || null,
      payload.account_holder || null,
      payload.account_number || null,
      payload.branch_code || null,
      payload.ewallet_number || null,
      'submitted'
    );
  return info.lastInsertRowid;
}

function insertApplicationDocument({ applicationId, userId, docType, file, extracted_amount = null, extracted_text = null }) {
  const publicFile = `/uploads/applications/${file.filename}`;
  return db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
      applicationId,
      userId,
      docType,
      publicFile,
      file.originalname,
      file.mimetype,
      extracted_amount,
      extracted_text,
      userId
    );
}

function insertKycDocument({ userId, docType, file }) {
  return db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name)
    VALUES (?,?,?,?)`).run(userId, docType, `/uploads/applications/${file.filename}`, file.originalname);
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

  if (payslips.length < 3) return { total, average, decision: 'insufficient_documents' };

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

router.post('/signup',
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  body('full_name').notEmpty(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, full_name, phone, id_number, address, city, province, postal_code,
            date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin } = req.body;

    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizeEmail(email));
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users
      (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
       date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin, role)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'rider')`).run(
        normalizeEmail(email), hash, full_name, phone || null, id_number || null,
        address || null, city || null, province || null, postal_code || null,
        date_of_birth || null, emergency_contact_name || null, emergency_contact_phone || null, country_of_origin || null
      );

    const user = db.prepare('SELECT id, email, full_name, role FROM users WHERE id = ?').get(info.lastInsertRowid);
    logAudit(user.id, 'user.signup', 'users', user.id, { email }, req.ip);
    res.json({ token: signToken(user), user });
  });

router.post('/signup-complete', signupUpload.fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'drivers_license', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'payslip_1', maxCount: 1 },
  { name: 'payslip_2', maxCount: 1 },
  { name: 'payslip_3', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      email, password, full_name, phone, id_number, address, city, province, postal_code,
      date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin,
      preferred_bike_id, monthly_income, years_riding, payout_preference,
      bank_name, account_holder, account_number, branch_code, ewallet_number
    } = req.body;

    if (!email || !password || !full_name || !phone || !id_number) {
      return res.status(400).json({ error: 'Please complete all required personal details' });
    }
    if (!preferred_bike_id) return res.status(400).json({ error: 'Please choose a preferred bike' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const requiredFiles = ['id_document', 'drivers_license', 'selfie', 'payslip_1', 'payslip_2', 'payslip_3'];
    for (const field of requiredFiles) {
      if (!getRequiredFile(req, field)) return res.status(400).json({ error: `Missing required file: ${field.replace(/_/g, ' ')}` });
    }

    if (payout_preference === 'eft' && (!bank_name || !account_holder || !account_number || !branch_code)) {
      return res.status(400).json({ error: 'Please provide all EFT banking details' });
    }
    if (payout_preference === 'ewallet' && !ewallet_number) {
      return res.status(400).json({ error: 'Please provide an e-wallet number' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizeEmail(email));
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const payload = {
      preferred_bike_id: Number(preferred_bike_id),
      monthly_income: monthly_income ? Number(monthly_income) : null,
      delivery_platforms: parsePlatforms(req.body.delivery_platforms),
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

    const hash = bcrypt.hashSync(password, 10);
    const created = db.transaction(() => {
      const userInfo = db.prepare(`INSERT INTO users
        (email, password_hash, full_name, phone, id_number, address, city, province, postal_code,
         date_of_birth, emergency_contact_name, emergency_contact_phone, country_of_origin, role)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'rider')`).run(
          normalizeEmail(email), hash, full_name, phone || null, id_number || null,
          address || null, city || null, province || null, postal_code || null,
          date_of_birth || null, emergency_contact_name || null, emergency_contact_phone || null, country_of_origin || null
        );
      const userId = userInfo.lastInsertRowid;
      const applicationId = createApplication(userId, payload);
      return { userId, applicationId };
    })();

    const idDocument = getRequiredFile(req, 'id_document');
    const driversLicense = getRequiredFile(req, 'drivers_license');
    const selfie = getRequiredFile(req, 'selfie');
    const payslipFiles = ['payslip_1', 'payslip_2', 'payslip_3'].map((field) => getRequiredFile(req, field)).filter(Boolean);

    insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'id_document', file: idDocument });
    insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'drivers_license', file: driversLicense });
    insertApplicationDocument({ applicationId: created.applicationId, userId: created.userId, docType: 'other', file: selfie });

    insertKycDocument({ userId: created.userId, docType: 'id_document', file: idDocument });
    insertKycDocument({ userId: created.userId, docType: 'drivers_license', file: driversLicense });
    insertKycDocument({ userId: created.userId, docType: 'selfie', file: selfie });

    const payslipInsights = await Promise.all(
      payslipFiles.map(payslip => extractPayslipInsights(path.join(uploadDir, payslip.filename), payslip.mimetype))
    );

    for (let i = 0; i < payslipFiles.length; i++) {
      insertApplicationDocument({
        applicationId: created.applicationId,
        userId: created.userId,
        docType: 'payslip',
        file: payslipFiles[i],
        extracted_amount: payslipInsights[i].extracted_amount || null,
        extracted_text: payslipInsights[i].extracted_text || null
      });
    }

    const decision = await recalcApplicationDecision(created.applicationId);
    const user = db.prepare('SELECT id, email, full_name, role FROM users WHERE id = ?').get(created.userId);
    logAudit(user.id, 'user.signup_complete', 'users', user.id, { application_id: created.applicationId }, req.ip);

    res.json({ token: signToken(user), user, application_id: created.applicationId, decision });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Sign up failed' });
  }
});

router.post('/login',
  body('email').isEmail(),
  body('password').notEmpty(),
  (req, res) => {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    logAudit(user.id, 'user.login', 'users', user.id, {}, req.ip);
    const safe = { id: user.id, email: user.email, full_name: user.full_name, role: user.role };
    res.json({ token: signToken(safe), user: safe });
  });

router.post('/forgot-password',
  body('email').isEmail(),
  async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
    const user = db.prepare(`SELECT id, email, full_name, status FROM users WHERE email = ? AND deleted_at IS NULL`).get(email);

    if (!user || user.status !== 'active') return res.json(generic);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(user.id);
    db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
      VALUES (?,?,?,?,?)`).run(user.id, tokenHash, passwordResetExpiryIso(), req.ip || null, req.get('user-agent') || null);

    const firstName = user.full_name?.split(' ')?.[0] || 'there';
    const resetUrl = buildResetUrl(rawToken);
    await sendNotification({
      userId: user.id,
      channel: 'email',
      type: 'password_reset',
      title: 'Reset your OnFleet password',
      message: `Hi ${firstName},\n\nWe received a request to reset your OnFleet password.\n\nReset link: ${resetUrl}\n\nThis link expires in ${readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60} minutes. If you did not request this, you can ignore this email.\n\nKind Regards\nOnFleet Team`
    });

    logAudit(user.id, 'user.password_reset_requested', 'users', user.id, {}, req.ip);
    res.json(generic);
  });

router.post('/reset-password',
  body('token').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  (req, res) => {
    const tokenHash = hashResetToken(req.body.token);
    const tokenRow = db.prepare(`SELECT prt.id, prt.user_id, u.email
      FROM password_reset_tokens prt
      JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = ?
        AND prt.used_at IS NULL
        AND prt.expires_at > CURRENT_TIMESTAMP
        AND u.deleted_at IS NULL`).get(tokenHash);

    if (!tokenRow) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const passwordHash = bcrypt.hashSync(req.body.new_password, 10);
    db.transaction(() => {
      db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(passwordHash, tokenRow.user_id);
      db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(tokenRow.user_id);
    })();

    logAudit(tokenRow.user_id, 'user.password_reset_completed', 'users', tokenRow.user_id, {}, req.ip);
    res.json({ ok: true, message: 'Password reset successful. You can now sign in.' });
  });

router.get('/me', authRequired, (req, res) => {
  const u = db.prepare(`SELECT id, email, full_name, phone, role, status, id_number, date_of_birth,
                        address, city, province, postal_code, emergency_contact_name,
                        emergency_contact_phone, avatar_url, country_of_origin, created_at
                        FROM users WHERE id = ? AND deleted_at IS NULL`).get(req.user.id);
  res.json({ user: u });
});

router.put('/me', authRequired, (req, res) => {
  const fields = ['full_name','phone','id_number','date_of_birth','address','city','province',
                  'postal_code','emergency_contact_name','emergency_contact_phone','avatar_url','country_of_origin'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.json({ ok: true });
  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

router.post('/me/selfie', authRequired, profileUpload.single('selfie'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Selfie image is required' });
  const avatarUrl = `/uploads/profiles/${req.file.filename}`;
  db.prepare(`UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(avatarUrl, req.user.id);
  const existing = db.prepare(`SELECT id FROM kyc_documents WHERE user_id = ? AND doc_type = 'selfie'`).get(req.user.id);
  if (existing) {
    db.prepare(`UPDATE kyc_documents SET file_path = ?, original_name = ?, uploaded_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(avatarUrl, req.file.originalname, existing.id);
  } else {
    db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
      VALUES (?, 'selfie', ?, ?, 'approved')`).run(req.user.id, avatarUrl, req.file.originalname);
  }
  res.json({ ok: true, avatar_url: avatarUrl });
});

router.post('/change-password', authRequired,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
  (req, res) => {
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user.id);
    if (!bcrypt.compareSync(req.body.current_password, u.password_hash)) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    const hash = bcrypt.hashSync(req.body.new_password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ ok: true });
  });

module.exports = router;
