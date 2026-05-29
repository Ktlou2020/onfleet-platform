const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { generateStrategicReport } = require('../services/strategicReport');
const { sendNotification, detectEmailProvider } = require('../services/notifier');

const router = express.Router();
const { branding: brandingUploadDir } = require('../uploadPaths');
const FLEET_OWNER_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const FLEET_OWNER_ROLE_SQL = FLEET_OWNER_ROLE_VALUES.map(() => '?').join(',');
const heroImageUpload = multer({
  storage: multer.diskStorage({
    destination: brandingUploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype))
});
router.use(authRequired, adminOnly);

function superadminOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  next();
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

function normalizeBulkUserIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  return [...new Set(rawIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
}

function selectBulkTargets({ user_ids, role, status }) {
  const ids = normalizeBulkUserIds(user_ids);
  let sql = `SELECT id, email, full_name, role, status, user_tags
    FROM users
    WHERE deleted_at IS NULL AND COALESCE(email, '') != ''`;
  const params = [];

  if (ids.length) {
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    if (role && ['rider', 'admin', 'superadmin'].includes(role)) {
      sql += ' AND role = ?';
      params.push(role);
    }
    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

function issuePasswordResetToken(userId, req) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  db.prepare(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL`).run(userId);
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, user_agent)
    VALUES (?,?,?,?,?)`).run(
    userId,
    tokenHash,
    passwordResetExpiryIso(),
    req.ip || null,
    req.get('user-agent') || null
  );
  return buildResetUrl(rawToken);
}

function buildBulkResetMessage(user, resetUrl, actorName, customMessage) {
  const firstName = user.full_name?.split(' ')?.[0] || 'there';
  const intro = customMessage ? `${String(customMessage).trim()}\n\n` : '';
  return `Hi ${firstName},\n\n${intro}We received a request to reset your OnFleet password.\n\nReset link: ${resetUrl}\n\nThis link expires in ${readEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60') || 60} minutes. If you were not expecting this email, please contact the OnFleet team.\n\nKind Regards\nOnFleet Team`;
}

function getSetting(key) {
  return db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(key)?.setting_value || null;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP`).run(key, value || null);
}

function fleetOrgScope(alias = 'b', orgAlias = 'o') {
  return `(${alias}.organization_id = ${orgAlias}.id OR (${alias}.organization_id IS NULL AND LOWER(TRIM(COALESCE(${alias}.fleet, ''))) IN (LOWER(TRIM(COALESCE(${orgAlias}.name, ''))), LOWER(TRIM(COALESCE(${orgAlias}.slug, ''))))))`;
}

function superadminVisibleBikeScope(alias = 'b') {
  return `${alias}.organization_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM organizations o
    WHERE LOWER(TRIM(COALESCE(${alias}.fleet, ''))) <> ''
      AND LOWER(TRIM(COALESCE(${alias}.fleet, ''))) IN (
        LOWER(TRIM(COALESCE(o.name, ''))),
        LOWER(TRIM(COALESCE(o.slug, '')))
      )
  )`;
}

function superadminPortalAgreementScope(aAlias = 'a', bAlias = 'b', uAlias = 'u') {
  return `${superadminVisibleBikeScope(bAlias)} AND ${uAlias}.organization_id IS NULL`;
}

function superadminPortalApplicationScope(aAlias = 'a', uAlias = 'u', bAlias = 'b') {
  return `${uAlias}.organization_id IS NULL AND (${bAlias}.id IS NULL OR ${superadminVisibleBikeScope(bAlias)})`;
}

function listFleetOwnerOrganizations() {
  const scope = fleetOrgScope('b', 'o');
  const rows = db.prepare(`SELECT
      o.id,
      o.name,
      o.slug,
      o.contact_email,
      o.contact_phone,
      o.city,
      o.fleet_size,
      o.plan_key,
      o.status,
      o.trial_started_at,
      o.trial_ends_at,
      o.max_bikes,
      o.max_admin_users,
      o.created_at,
      o.updated_at,
      COALESCE((SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.role IN (${FLEET_OWNER_ROLE_SQL})), 0) AS member_count,
      COALESCE((SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id AND u.deleted_at IS NULL AND u.status = 'active' AND u.role IN (${FLEET_OWNER_ROLE_SQL})), 0) AS active_member_count,
      COALESCE((SELECT COUNT(*) FROM bikes b WHERE ${scope}), 0) AS bike_count,
      COALESCE((SELECT COUNT(*) FROM bikes b WHERE ${scope} AND b.status = 'active'), 0) AS active_bikes,
      COALESCE((SELECT COUNT(*) FROM bikes b WHERE ${scope} AND b.status = 'ready_to_go'), 0) AS ready_bikes,
      COALESCE((SELECT COUNT(*)
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND a.status IN ('active', 'paused', 'defaulted')), 0) AS open_agreements,
      COALESCE((SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
        FROM payment_schedules ps
        JOIN agreements a ON a.id = ps.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND ps.status = 'overdue'), 0) AS overdue_amount,
      COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND p.status = 'success'
          AND COALESCE(p.paid_at, p.created_at) >= datetime('now', '-30 days')), 0) AS revenue_30d,
      COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND p.status = 'success'), 0) AS revenue_total,
      (SELECT MAX(COALESCE(p.paid_at, p.created_at))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND p.status = 'success') AS last_payment_at
    FROM organizations o
    ORDER BY CASE
      WHEN o.status = 'past_due' THEN 0
      WHEN o.status = 'trialing' THEN 1
      WHEN o.status = 'active' THEN 2
      WHEN o.status = 'suspended' THEN 3
      ELSE 4
    END,
    o.created_at DESC`).all(...FLEET_OWNER_ROLE_VALUES, ...FLEET_OWNER_ROLE_VALUES);

  return rows.map((row) => ({
    ...row,
    member_count: Number(row.member_count || 0),
    active_member_count: Number(row.active_member_count || 0),
    bike_count: Number(row.bike_count || 0),
    active_bikes: Number(row.active_bikes || 0),
    ready_bikes: Number(row.ready_bikes || 0),
    open_agreements: Number(row.open_agreements || 0),
    overdue_amount: Number(row.overdue_amount || 0),
    revenue_30d: Number(row.revenue_30d || 0),
    revenue_total: Number(row.revenue_total || 0),
    payer_status: Number(row.revenue_30d || 0) > 0 ? 'payer' : 'non_payer'
  }));
}

function listFleetOwnerUsers() {
  const rows = db.prepare(`SELECT
      u.id,
      u.email,
      u.full_name,
      u.phone,
      u.city,
      u.role,
      u.status,
      u.created_at,
      u.updated_at,
      o.id AS organization_id,
      o.name AS organization_name,
      o.slug AS organization_slug,
      o.status AS organization_status,
      o.plan_key,
      o.contact_email,
      o.contact_phone,
      o.fleet_size,
      o.max_bikes,
      o.max_admin_users,
      COALESCE((SELECT COUNT(*) FROM users u2 WHERE u2.organization_id = o.id AND u2.deleted_at IS NULL AND u2.role IN (${FLEET_OWNER_ROLE_SQL})), 0) AS organization_member_count,
      COALESCE((SELECT COUNT(*) FROM bikes b WHERE ${fleetOrgScope('b', 'o')}), 0) AS organization_bike_count,
      COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${fleetOrgScope('b', 'o')}
          AND p.status = 'success'
          AND COALESCE(p.paid_at, p.created_at) >= datetime('now', '-30 days')), 0) AS organization_revenue_30d,
      (SELECT MAX(COALESCE(p.paid_at, p.created_at))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${fleetOrgScope('b', 'o')}
          AND p.status = 'success') AS organization_last_payment_at
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
    WHERE u.deleted_at IS NULL AND u.role IN (${FLEET_OWNER_ROLE_SQL})
    ORDER BY o.name ASC,
      CASE
        WHEN u.role = 'fleet_owner_admin' THEN 0
        WHEN u.role = 'fleet_owner_ops' THEN 1
        WHEN u.role = 'fleet_owner_billing' THEN 2
        ELSE 3
      END,
      u.created_at ASC`).all(...FLEET_OWNER_ROLE_VALUES, ...FLEET_OWNER_ROLE_VALUES);

  return rows.map((row) => ({
    ...row,
    organization_member_count: Number(row.organization_member_count || 0),
    organization_bike_count: Number(row.organization_bike_count || 0),
    organization_revenue_30d: Number(row.organization_revenue_30d || 0),
    organization_payer_status: Number(row.organization_revenue_30d || 0) > 0 ? 'payer' : 'non_payer'
  }));
}

router.get('/branding', superadminOnly, (req, res) => {
  res.json({ hero_image_url: getSetting('landing_hero_image_url') });
});

router.post('/branding/hero-image', superadminOnly, heroImageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Hero image file is required' });
  const publicPath = `/uploads/branding/${req.file.filename}`;
  setSetting('landing_hero_image_url', publicPath);
  logAudit(req.user.id, 'branding.hero_image', 'app_settings', null, { hero_image_url: publicPath });
  res.json({ ok: true, hero_image_url: publicPath });
});

router.get('/dashboard', (req, res) => {
  const agreementScope = superadminPortalAgreementScope('a', 'b', 'u');
  const applicationScope = superadminPortalApplicationScope('a', 'u', 'b');
  const stats = {
    riders: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'rider' AND deleted_at IS NULL AND organization_id IS NULL`).get().c,
    admins: db.prepare(`SELECT COUNT(*) c FROM users WHERE role IN ('admin','superadmin') AND deleted_at IS NULL`).get().c,
    active_agreements: db.prepare(`SELECT COUNT(*) c
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.status = 'active' AND ${agreementScope}`).get().c,
    completed_agreements: db.prepare(`SELECT COUNT(*) c
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.status = 'completed' AND ${agreementScope}`).get().c,
    bikes_available: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'ready_to_go' AND organization_id IS NULL`).get().c,
    bikes_allocated: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'active' AND organization_id IS NULL`).get().c,
    bikes_maintenance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'repairs' AND organization_id IS NULL`).get().c,
    pending_applications: db.prepare(`SELECT COUNT(*) c
      FROM applications a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN bikes b ON b.id = a.preferred_bike_id
      WHERE a.status IN ('submitted','under_review') AND ${applicationScope}`).get().c,
    pending_kyc: db.prepare(`SELECT COUNT(*) c
      FROM application_documents d
      JOIN applications a ON a.id = d.application_id
      JOIN users u ON u.id = a.user_id
      LEFT JOIN bikes b ON b.id = a.preferred_bike_id
      WHERE d.status = 'uploaded' AND ${applicationScope}`).get().c,
    revenue_total: db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(p.net_amount,0), p.amount)),0) s
      FROM payments p
      JOIN agreements a ON a.id = p.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE p.status = 'success' AND ${agreementScope}`).get().s,
    revenue_30d: db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(p.net_amount,0), p.amount)),0) s
      FROM payments p
      JOIN agreements a ON a.id = p.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE p.status = 'success' AND COALESCE(p.paid_at, p.created_at) >= datetime('now','-30 days') AND ${agreementScope}`).get().s,
    overdue_amount: db.prepare(`SELECT COALESCE(SUM(ps.amount_due - ps.amount_paid),0) s
      FROM payment_schedules ps
      JOIN agreements a ON a.id = ps.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE ps.status = 'overdue' AND ${agreementScope}`).get().s,
    overdue_count: db.prepare(`SELECT COUNT(DISTINCT ps.agreement_id) c
      FROM payment_schedules ps
      JOIN agreements a ON a.id = ps.agreement_id
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE ps.status = 'overdue' AND ${agreementScope}`).get().c,
    default_action_count: db.prepare(`SELECT COUNT(*) c
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.status = 'defaulted'
        AND b.status NOT IN ('stolen','written_off','sold')
        AND ${agreementScope}`).get().c,
    upcoming_services: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE next_service_date IS NOT NULL AND next_service_date <= date('now','+14 days') AND status = 'active' AND organization_id IS NULL`).get().c,
    expiring_insurance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE insurance_expiry IS NOT NULL AND insurance_expiry <= date('now','+30 days') AND organization_id IS NULL`).get().c,
    expiring_license_disc: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE license_disc_expiry IS NOT NULL AND license_disc_expiry <= date('now','+30 days') AND organization_id IS NULL`).get().c
  };
  const weekly = db.prepare(`SELECT strftime('%Y-%W', COALESCE(p.paid_at, p.created_at)) week, COALESCE(SUM(COALESCE(NULLIF(p.net_amount,0), p.amount)),0) total
    FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE p.status = 'success' AND COALESCE(p.paid_at, p.created_at) >= datetime('now','-90 days') AND ${agreementScope}
    GROUP BY week ORDER BY week`).all();
  res.json({ stats, weekly_revenue: weekly });
});

router.get('/fleet-owners/dashboard', (req, res) => {
  const organizations = listFleetOwnerOrganizations();
  const summary = {
    organizations: organizations.length,
    trialing: organizations.filter((org) => org.status === 'trialing').length,
    active: organizations.filter((org) => org.status === 'active').length,
    past_due: organizations.filter((org) => org.status === 'past_due').length,
    suspended: organizations.filter((org) => org.status === 'suspended').length,
    payers_30d: organizations.filter((org) => org.payer_status === 'payer').length,
    non_payers_30d: organizations.filter((org) => org.payer_status === 'non_payer').length,
    bikes: organizations.reduce((sum, org) => sum + Number(org.bike_count || 0), 0),
    active_bikes: organizations.reduce((sum, org) => sum + Number(org.active_bikes || 0), 0),
    open_agreements: organizations.reduce((sum, org) => sum + Number(org.open_agreements || 0), 0),
    overdue_amount: organizations.reduce((sum, org) => sum + Number(org.overdue_amount || 0), 0),
    revenue_30d: organizations.reduce((sum, org) => sum + Number(org.revenue_30d || 0), 0),
    revenue_total: organizations.reduce((sum, org) => sum + Number(org.revenue_total || 0), 0),
    fleet_owner_users: organizations.reduce((sum, org) => sum + Number(org.member_count || 0), 0)
  };

  res.json({ summary, organizations });
});

router.get('/fleet-owners', superadminOnly, (req, res) => {
  res.json({
    roles: FLEET_OWNER_ROLE_VALUES,
    organizations: listFleetOwnerOrganizations(),
    users: listFleetOwnerUsers()
  });
});

router.post('/fleet-owners/:id/status', superadminOnly, (req, res) => {
  const userId = Number(req.params.id);
  const status = String(req.body.status || '').trim();
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid fleet owner id' });
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const target = db.prepare(`SELECT id, email, full_name, role, status, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(userId);
  if (!target || !FLEET_OWNER_ROLE_VALUES.includes(target.role)) return res.status(404).json({ error: 'Fleet owner not found' });

  db.prepare(`UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, userId);
  logAudit(req.user.id, 'fleet_owner.user_status', 'users', userId, {
    email: target.email,
    from: target.status,
    to: status,
    organization_id: target.organization_id
  }, req.ip);
  res.json({ ok: true });
});

router.post('/fleet-owners/:id/role', superadminOnly, (req, res) => {
  const userId = Number(req.params.id);
  const role = String(req.body.role || '').trim();
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid fleet owner id' });
  if (!FLEET_OWNER_ROLE_VALUES.includes(role)) return res.status(400).json({ error: 'Invalid fleet owner role' });

  const target = db.prepare(`SELECT id, email, full_name, role, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(userId);
  if (!target || !FLEET_OWNER_ROLE_VALUES.includes(target.role)) return res.status(404).json({ error: 'Fleet owner not found' });

  db.prepare(`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(role, userId);
  logAudit(req.user.id, 'fleet_owner.user_role', 'users', userId, {
    email: target.email,
    from: target.role,
    to: role,
    organization_id: target.organization_id
  }, req.ip);
  res.json({ ok: true });
});

router.post('/fleet-owners/:id/send-password-reset', superadminOnly, async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid fleet owner id' });

  const target = db.prepare(`SELECT id, email, full_name, role, status, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(userId);
  if (!target || !FLEET_OWNER_ROLE_VALUES.includes(target.role)) return res.status(404).json({ error: 'Fleet owner not found' });
  if (target.status !== 'active') return res.status(400).json({ error: 'Only active fleet owners can receive password reset links' });

  const resetUrl = issuePasswordResetToken(target.id, req);
  await sendNotification({
    userId: target.id,
    channel: 'email',
    type: 'password_reset',
    title: 'Reset your OnFleet password',
    message: buildBulkResetMessage(target, resetUrl, req.user.full_name || req.user.email || 'OnFleet', req.body.message)
  });

  logAudit(req.user.id, 'fleet_owner.password_reset', 'users', userId, {
    email: target.email,
    organization_id: target.organization_id
  }, req.ip);

  res.json({ ok: true });
});

router.get('/strategy-report', (req, res) => {
  res.json(generateStrategicReport());
});

router.get('/email-provider-status', (req, res) => {
  const provider = detectEmailProvider();
  res.json({
    provider: provider.name,
    channel: provider.channel,
    configured: provider.configured,
    from_name: provider.fromName,
    from_email: provider.fromEmail
  });
});

router.get('/users', (req, res) => {
  const role = req.query.role;
  const sql = `SELECT id, email, full_name, phone, role, status, country_of_origin, avatar_url, user_tags, created_at
    FROM users
    WHERE deleted_at IS NULL ${role ? 'AND role = ?' : ''}
    ORDER BY created_at DESC`;
  const users = role ? db.prepare(sql).all(role) : db.prepare(sql).all();
  res.json({ users });
});

router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  delete user.password_hash;
  const docs = db.prepare(`SELECT * FROM kyc_documents WHERE user_id = ?`).all(req.params.id);
  const apps = db.prepare(`SELECT * FROM applications WHERE user_id = ?`).all(req.params.id);
  const ags = db.prepare(`SELECT a.*, b.make, b.model FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.user_id = ?`).all(req.params.id);
  res.json({ user, kyc_documents: docs, applications: apps, agreements: ags });
});

router.post('/users', superadminOnly, (req, res) => {
  const { email, password, full_name, phone, role } = req.body;
  if (!email || !password || !full_name || !['rider', 'admin', 'superadmin'].includes(role)) {
    return res.status(400).json({ error: 'email, password, full_name and valid role are required' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizedEmail);
  if (exists) return res.status(409).json({ error: 'Email already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, role, status)
    VALUES (?,?,?,?,?, 'active')`).run(normalizedEmail, hash, full_name, phone || null, role);
  logAudit(req.user.id, 'user.create', 'users', info.lastInsertRowid, { role });
  res.json({ id: info.lastInsertRowid });
});

router.post('/users/bulk-email', async (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  const includeInApp = !!req.body.include_in_app;
  if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

  const targets = selectBulkTargets({
    user_ids: req.body.user_ids,
    role: req.body.role,
    status: req.body.status || 'active'
  });

  if (!targets.length) return res.status(400).json({ error: 'No matching users found for this bulk email' });

  let emailSent = 0;
  let emailFailed = 0;
  let inAppSent = 0;
  const failures = [];

  for (const target of targets) {
    try {
      await sendNotification({
        userId: target.id,
        channel: 'email',
        type: 'admin_bulk_email',
        title: subject,
        message
      });
      emailSent += 1;
      if (includeInApp) {
        await sendNotification({
          userId: target.id,
          channel: 'in_app',
          type: 'admin_bulk_email',
          title: subject,
          message
        });
        inAppSent += 1;
      }
    } catch (error) {
      emailFailed += 1;
      failures.push({ id: target.id, email: target.email, error: error.message });
    }
  }

  logAudit(req.user.id, 'users.bulk_email', 'users', null, {
    targeted: targets.length,
    email_sent: emailSent,
    email_failed: emailFailed,
    include_in_app: includeInApp,
    scope_role: req.body.role || null,
    scope_status: req.body.status || 'active',
    explicit_user_count: normalizeBulkUserIds(req.body.user_ids).length
  }, req.ip);

  res.json({
    ok: true,
    targeted: targets.length,
    email_sent: emailSent,
    email_failed: emailFailed,
    in_app_sent: inAppSent,
    failures: failures.slice(0, 20)
  });
});

router.post('/users/bulk-password-reset', async (req, res) => {
  const customMessage = String(req.body.message || '').trim();
  const targets = selectBulkTargets({
    user_ids: req.body.user_ids,
    role: req.body.role,
    status: req.body.status || 'active'
  }).filter((user) => user.status === 'active');

  if (!targets.length) return res.status(400).json({ error: 'No active users found for password reset' });

  const actorName = req.user.full_name || req.user.email || 'An OnFleet administrator';
  let emailed = 0;
  let failed = 0;
  const failures = [];

  for (const target of targets) {
    try {
      const resetUrl = issuePasswordResetToken(target.id, req);
      await sendNotification({
        userId: target.id,
        channel: 'email',
        type: 'password_reset',
        title: 'Reset your OnFleet password',
        message: buildBulkResetMessage(target, resetUrl, actorName, customMessage)
      });
      emailed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ id: target.id, email: target.email, error: error.message });
    }
  }

  logAudit(req.user.id, 'users.bulk_password_reset', 'users', null, {
    targeted: targets.length,
    emailed,
    failed,
    scope_role: req.body.role || null,
    scope_status: req.body.status || 'active',
    explicit_user_count: normalizeBulkUserIds(req.body.user_ids).length
  }, req.ip);

  res.json({
    ok: true,
    targeted: targets.length,
    emailed,
    failed,
    failures: failures.slice(0, 20)
  });
});

router.post('/users/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid' });
  db.prepare(`UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`).run(status, req.params.id);
  logAudit(req.user.id, 'user.status', 'users', Number(req.params.id), { status });
  res.json({ ok: true });
});

router.post('/users/:id/role', superadminOnly, (req, res) => {
  const { role } = req.body;
  if (!['rider', 'admin', 'superadmin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const target = db.prepare(`SELECT id, role, email FROM users WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role' });
  db.prepare(`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(role, target.id);
  logAudit(req.user.id, 'user.role', 'users', Number(req.params.id), { from: target.role, to: role, email: target.email });
  res.json({ ok: true });
});

router.delete('/users/:id', superadminOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
  const tombstoneEmail = `removed+${target.id}+${Date.now()}@onfleet.local`;
  db.prepare(`UPDATE users
    SET deleted_at = CURRENT_TIMESTAMP, status = 'suspended', email = ?, phone = NULL, full_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(tombstoneEmail, `Removed User ${target.id}`, target.id);
  logAudit(req.user.id, 'user.remove', 'users', Number(req.params.id), { previous_role: target.role });
  res.json({ ok: true });
});

router.get('/audit-logs', (req, res) => {
  const logs = db.prepare(`SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.created_at DESC LIMIT 200`).all();
  res.json({ logs });
});

module.exports = router;
