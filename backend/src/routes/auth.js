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
const { logAudit } = require('../utils/helpersPg');
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
const { profiles: profileUploadDir } = require('../uploadPaths');
const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const FLEET_PLAN_ENTITLEMENTS = {
  trial:  { max_bikes: 6,    max_admin_users: 2 },
  small:  { max_bikes: 6,    max_admin_users: 2 },
  medium: { max_bikes: 20,   max_admin_users: 3 },
  large:  { max_bikes: 35,   max_admin_users: 5 },
  empire: { max_bikes: 9999, max_admin_users: 20 },
};

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

// Who a rider should contact when something goes wrong. A rider recruited by
// a fleet owner belongs to that owner, so their first line of support is that
// fleet's own contact details (captured at fleet signup) — not us. Riders on
// the direct platform fall back to the OnFleet support env vars.
//
// Everything is optional: an unconfigured platform simply returns null fields
// and the UI hides the card rather than showing a dead phone number.
router.get('/support-contact', authRequired, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT o.name, o.contact_phone, o.contact_email
       FROM users u LEFT JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`, [req.user.id]);
  const org = rows[0];

  const fromOrg = org?.contact_phone || org?.contact_email;
  const phone = fromOrg ? org.contact_phone : readEnv('SUPPORT_PHONE', '') || null;
  const email = fromOrg ? org.contact_email : readEnv('SUPPORT_EMAIL', '') || null;
  // WhatsApp defaults to the voice number — one number is the common case, and
  // wa.me just needs the digits.
  const whatsapp = fromOrg
    ? org.contact_phone
    : (readEnv('SUPPORT_WHATSAPP', '') || readEnv('SUPPORT_PHONE', '') || null);

  res.json({
    name: fromOrg ? org.name : (readEnv('SUPPORT_NAME', '') || 'OnFleet support'),
    phone: phone || null,
    email: email || null,
    whatsapp: whatsapp || null,
    source: fromOrg ? 'fleet_owner' : 'platform',
  });
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
