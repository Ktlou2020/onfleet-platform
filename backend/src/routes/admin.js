const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const axios = require('axios');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');
const { generateStrategicReport } = require('../services/strategicReport');
const { requireValidMime } = require('../utils/validateUpload');
const { sendNotification, sendHtmlEmail, detectEmailProvider } = require('../services/notifier');
const { getTemplate, listTemplates, previewTemplate } = require('../services/emailTemplates');

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
    if (role && ['rider', 'admin', 'superadmin', 'technician'].includes(role)) {
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
          AND p.status = 'success') AS last_payment_at,
      COALESCE((SELECT COUNT(*)
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}
          AND p.status = 'success'), 0) AS payment_count,
      COALESCE((SELECT COUNT(*)
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE ${scope}), 0) AS total_agreements,
      COALESCE((SELECT COUNT(*)
        FROM users u
        WHERE u.organization_id = o.id AND u.role = 'rider' AND u.deleted_at IS NULL), 0) AS rider_count,
      COALESCE((SELECT SUM(b.rental_weekly)
        FROM bikes b
        WHERE ${scope} AND b.status IN ('active', 'ready_to_go')), 0) AS weekly_potential
    FROM organizations o
    ORDER BY CASE
      WHEN o.status = 'past_due' THEN 0
      WHEN o.status = 'trialing' THEN 1
      WHEN o.status = 'active' THEN 2
      WHEN o.status = 'suspended' THEN 3
      ELSE 4
    END,
    o.created_at DESC`).all(...FLEET_OWNER_ROLE_VALUES, ...FLEET_OWNER_ROLE_VALUES);

  return rows.map((row) => {
    const trialDaysLeft = row.trial_ends_at
      ? Math.ceil((new Date(row.trial_ends_at) - Date.now()) / 86400000)
      : null;
    return {
      ...row,
      member_count: Number(row.member_count || 0),
      active_member_count: Number(row.active_member_count || 0),
      bike_count: Number(row.bike_count || 0),
      active_bikes: Number(row.active_bikes || 0),
      ready_bikes: Number(row.ready_bikes || 0),
      open_agreements: Number(row.open_agreements || 0),
      total_agreements: Number(row.total_agreements || 0),
      payment_count: Number(row.payment_count || 0),
      rider_count: Number(row.rider_count || 0),
      weekly_potential: Number(row.weekly_potential || 0),
      overdue_amount: Number(row.overdue_amount || 0),
      revenue_30d: Number(row.revenue_30d || 0),
      revenue_total: Number(row.revenue_total || 0),
      trial_days_left: trialDaysLeft,
      payer_status: Number(row.revenue_30d || 0) > 0 ? 'payer' : 'non_payer'
    };
  });
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

router.post('/branding/hero-image', superadminOnly, heroImageUpload.single('image'), requireValidMime(['image/jpeg', 'image/png', 'image/webp']), (req, res) => {
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

router.post('/impersonate/:org_id', superadminOnly, (req, res) => {
  const orgId = Number(req.params.org_id);
  if (!Number.isInteger(orgId) || orgId <= 0) return res.status(400).json({ error: 'Invalid org id' });

  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const target = db.prepare(
    `SELECT u.id, u.email, u.full_name, u.role, u.organization_id,
      o.name organization_name, o.slug organization_slug, o.status organization_status, o.plan_key organization_plan_key
     FROM users u
     LEFT JOIN organizations o ON o.id = u.organization_id
     WHERE u.organization_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
     ORDER BY CASE u.role WHEN 'fleet_owner_admin' THEN 0 ELSE 1 END LIMIT 1`
  ).get(orgId);

  if (!target) return res.status(404).json({ error: 'No active users found in this organization' });

  const token = jwt.sign(
    { uid: target.id, role: target.role, impersonated_by: req.user.id },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  logAudit(req.user.id, 'superadmin.impersonate', 'organizations', orgId, {
    org_name: org.name, target_user_id: target.id, target_email: target.email
  }, req.ip);

  res.json({ token, user: target });
});

const FLEET_PLAN_ENTITLEMENTS = {
  trial:      { status: 'trialing', max_bikes: 10,  max_admin_users: 2  },
  small:      { status: 'active',   max_bikes: 20,  max_admin_users: 3  },
  medium:     { status: 'active',   max_bikes: 60,  max_admin_users: 5  },
  large:      { status: 'active',   max_bikes: 100, max_admin_users: 10 },
  enterprise: { status: 'active',   max_bikes: 999, max_admin_users: 50 }
};

router.post('/organizations/:id/plan', superadminOnly, (req, res) => {
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId) || orgId <= 0) return res.status(400).json({ error: 'Invalid organization id' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const planKey = String(req.body.plan_key || '').trim();
  if (!FLEET_PLAN_ENTITLEMENTS[planKey]) {
    return res.status(400).json({ error: `Invalid plan. Valid options: ${Object.keys(FLEET_PLAN_ENTITLEMENTS).join(', ')}` });
  }

  const defaults = FLEET_PLAN_ENTITLEMENTS[planKey];
  const newStatus = String(req.body.status || defaults.status).trim();
  const validStatuses = ['trialing', 'active', 'past_due', 'suspended', 'cancelled'];
  if (!validStatuses.includes(newStatus)) return res.status(400).json({ error: 'Invalid status' });

  const maxBikes = Number(req.body.max_bikes) || defaults.max_bikes;
  const maxAdmins = Number(req.body.max_admin_users) || defaults.max_admin_users;

  db.prepare(`UPDATE organizations SET plan_key = ?, status = ?, max_bikes = ?, max_admin_users = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(planKey, newStatus, maxBikes, maxAdmins, orgId);

  logAudit(req.user.id, 'organization.plan_changed', 'organizations', orgId, {
    from_plan: org.plan_key,
    to_plan: planKey,
    from_status: org.status,
    to_status: newStatus,
    max_bikes: maxBikes,
    max_admin_users: maxAdmins
  }, req.ip);

  res.json({ ok: true, plan_key: planKey, status: newStatus, max_bikes: maxBikes, max_admin_users: maxAdmins });
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

router.delete('/organizations/:id', superadminOnly, (req, res) => {
  const orgId = Number(req.params.id);
  if (!Number.isInteger(orgId) || orgId <= 0) return res.status(400).json({ error: 'Invalid organization id' });

  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const userCount = db.prepare('SELECT COUNT(*) as n FROM users WHERE organization_id = ?').get(orgId).n;

  // Disable FK enforcement for this cascading delete. better-sqlite3 is synchronous
  // so no concurrent request can interleave between PRAGMA OFF and PRAGMA ON.
  db.prepare('PRAGMA foreign_keys = OFF').run();
  const deleteTx = db.transaction(() => {
    db.prepare('DELETE FROM fleet_wallet_transactions WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM fleet_payout_requests WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM fleet_wallets WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM rider_subscriptions WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM collections_actions WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM api_keys WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM hubs WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM bikes WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM users WHERE organization_id = ?').run(orgId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
  });
  try {
    deleteTx();
  } finally {
    db.prepare('PRAGMA foreign_keys = ON').run();
  }

  logAudit(req.user.id, 'organization.deleted', 'organizations', orgId, {
    name: org.name,
    plan_key: org.plan_key,
    status: org.status,
    deleted_users: userCount
  }, req.ip);

  res.json({ ok: true, deleted_users: userCount });
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
  try {
    await sendNotification({
      userId: target.id,
      channel: 'email',
      type: 'password_reset',
      title: 'Reset your OnFleet password',
      message: buildBulkResetMessage(target, resetUrl, req.user.full_name || req.user.email || 'OnFleet', req.body.message)
    });
  } catch (emailErr) {
    console.error('[admin] fleet-owner password reset email failed:', emailErr.message);
    return res.status(502).json({ error: 'Password reset link was created but the email could not be delivered. Check email provider configuration.' });
  }

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

router.post('/users', superadminOnly, async (req, res) => {
  const { email, password, full_name, phone, role } = req.body;
  if (!email || !password || !full_name || !['rider', 'admin', 'superadmin', 'technician'].includes(role)) {
    return res.status(400).json({ error: 'email, password, full_name and valid role are required' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(normalizedEmail);
  if (exists) return res.status(409).json({ error: 'Email already exists' });
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, role, status)
    VALUES (?,?,?,?,?, 'active')`).run(normalizedEmail, hash, full_name, phone || null, role);
  logAudit(req.user.id, 'user.create', 'users', info.lastInsertRowid, { role });
  res.json({ id: info.lastInsertRowid });
});

router.post('/users/bulk-email', async (req, res) => {
  try {
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

  const cappedTargets = targets.slice(0, 200);
  let emailSent = 0;
  let emailFailed = 0;
  let inAppSent = 0;
  const failures = [];

  for (const target of cappedTargets) {
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
    targeted: cappedTargets.length,
    email_sent: emailSent,
    email_failed: emailFailed,
    include_in_app: includeInApp,
    scope_role: req.body.role || null,
    scope_status: req.body.status || 'active',
    explicit_user_count: normalizeBulkUserIds(req.body.user_ids).length
  }, req.ip);

  res.json({
    ok: true,
    targeted: cappedTargets.length,
    email_sent: emailSent,
    email_failed: emailFailed,
    in_app_sent: inAppSent,
    failures: failures.slice(0, 20)
  });
  } catch (err) {
    console.error('[bulk-email]', err.message);
    res.status(500).json({ error: err.message || 'Bulk email failed' });
  }
});

router.post('/users/bulk-password-reset', async (req, res) => {
  try {
  const customMessage = String(req.body.message || '').trim();
  const targets = selectBulkTargets({
    user_ids: req.body.user_ids,
    role: req.body.role,
    status: req.body.status || 'active'
  }).filter((user) => user.status === 'active');

  if (!targets.length) return res.status(400).json({ error: 'No active users found for password reset' });

  const cappedTargets = targets.slice(0, 200);
  const actorName = req.user.full_name || req.user.email || 'An OnFleet administrator';
  let emailed = 0;
  let failed = 0;
  const failures = [];

  for (const target of cappedTargets) {
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
    targeted: cappedTargets.length,
    emailed,
    failed,
    scope_role: req.body.role || null,
    scope_status: req.body.status || 'active',
    explicit_user_count: normalizeBulkUserIds(req.body.user_ids).length
  }, req.ip);

  res.json({
    ok: true,
    targeted: cappedTargets.length,
    emailed,
    failed,
    failures: failures.slice(0, 20)
  });
  } catch (err) {
    console.error('[bulk-password-reset]', err.message);
    res.status(500).json({ error: err.message || 'Bulk password reset failed' });
  }
});

router.post('/users/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid' });
  const target = db.prepare('SELECT role FROM users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Cannot change status of superadmin' });
  db.prepare(`UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`).run(status, req.params.id);
  logAudit(req.user.id, 'user.status', 'users', Number(req.params.id), { status });
  res.json({ ok: true });
});

router.post('/users/:id/role', superadminOnly, (req, res) => {
  const { role } = req.body;
  if (!['rider', 'admin', 'superadmin', 'technician'].includes(role)) {
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
  if (target.role === 'technician') return res.status(400).json({ error: 'Workshop technicians cannot be deleted here. Use the Workshop Staff tab to suspend this user.' });
  const tombstoneEmail = `removed+${target.id}+${Date.now()}@onfleet.local`;
  db.prepare(`UPDATE users
    SET deleted_at = CURRENT_TIMESTAMP, status = 'suspended', email = ?, phone = NULL, full_name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(tombstoneEmail, `Removed User ${target.id}`, target.id);
  logAudit(req.user.id, 'user.remove', 'users', Number(req.params.id), { previous_role: target.role });
  res.json({ ok: true });
});

router.get('/audit-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 500), 2000);
  const { date_from, date_to, action, actor_id } = req.query;
  const where = [];
  const params = [];
  if (date_from) { where.push(`l.created_at >= ?`); params.push(date_from); }
  if (date_to) { where.push(`l.created_at <= ?`); params.push(date_to + 'T23:59:59'); }
  if (action) { where.push(`l.action = ?`); params.push(action); }
  if (actor_id) { where.push(`l.actor_id = ?`); params.push(Number(actor_id)); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const logs = db.prepare(`SELECT l.*, u.full_name FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id ${whereClause} ORDER BY l.created_at DESC LIMIT ?`).all(...params, limit);
  const actions = db.prepare(`SELECT DISTINCT action FROM audit_logs ORDER BY action`).all().map((r) => r.action);
  res.json({ logs, actions });
});

// ---------- FLEET PAYOUT REQUESTS ----------

router.get('/fleet-payouts', (req, res) => {
  const requests = db.prepare(`SELECT p.*, o.name AS org_name, u.full_name AS requested_by_name,
      pu.full_name AS processed_by_name
    FROM fleet_payout_requests p
    JOIN organizations o ON o.id = p.organization_id
    JOIN users u ON u.id = p.requested_by
    LEFT JOIN users pu ON pu.id = p.processed_by
    ORDER BY
      CASE p.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
      p.created_at DESC
    LIMIT 200`).all();
  res.json({ requests });
});

router.post('/fleet-payouts/:id/process', superadminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid payout request id' });
  const request = db.prepare('SELECT * FROM fleet_payout_requests WHERE id = ?').get(id);
  if (!request) return res.status(404).json({ error: 'Payout request not found' });
  if (request.status === 'paid') return res.status(400).json({ error: 'Payout already marked as paid' });

  const { action, admin_notes } = req.body;
  if (!['approve', 'paid', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use approve, paid, or reject' });
  }

  const newStatus = action === 'approve' ? 'approved' : action === 'paid' ? 'paid' : 'rejected';

  if (newStatus === 'rejected' && request.status !== 'paid') {
    // Refund the wallet balance
    db.transaction(() => {
      db.prepare(`UPDATE fleet_wallets SET balance = balance + ?, total_withdrawn = total_withdrawn - ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
        .run(request.amount_requested, request.amount_requested, request.organization_id);
      db.prepare(`DELETE FROM fleet_wallet_transactions WHERE payout_request_id = ?`).run(id);
    })();
  }

  db.prepare(`UPDATE fleet_payout_requests SET status = ?, admin_notes = ?, processed_by = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(newStatus, admin_notes || null, req.user.id, id);

  logAudit(req.user.id, `fleet.payout.${newStatus}`, 'fleet_payout_requests', id, { action, admin_notes }, req.ip);

  const payoutMessages = {
    approved: (fmt) => `Your payout request of ${fmt} has been approved and is being processed. Funds will arrive in your bank account within 1–2 business days.`,
    paid:     (fmt) => `Your payout of ${fmt} has been paid into your bank account.`,
    rejected: (fmt) => `Your payout request of ${fmt} has been declined.${admin_notes ? ` Reason: ${admin_notes}` : ' Please contact OnFleet support for more information.'}`,
  };
  const fmtAmount = `R${Number(request.net_payout).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const payoutMsg = payoutMessages[newStatus]?.(fmtAmount);
  if (payoutMsg) {
    sendNotification({
      userId: request.requested_by,
      channel: 'email',
      type: `payout_${newStatus}`,
      title: `Payout ${newStatus} · ${fmtAmount}`,
      message: payoutMsg
    }).catch((e) => console.error(`[admin] payout notify failed for request ${id}:`, e.message));
  }

  res.json({ ok: true, status: newStatus });
});

// ── Fleet owner email campaigns ───────────────────────────────────────────────
router.get('/email-templates', superadminOnly, (req, res) => {
  const key = req.query.preview;
  if (key) {
    const preview = previewTemplate(key);
    if (!preview) return res.status(404).json({ error: 'Template not found' });
    return res.json(preview);
  }
  res.json({ templates: listTemplates() });
});

router.post('/fleet-owners/email', superadminOnly, async (req, res) => {
  const { template_key, org_ids, custom_subject, custom_message, preview } = req.body || {};

  if (!template_key && !custom_message) {
    return res.status(400).json({ error: 'Provide template_key or custom_message' });
  }

  let targetOrgs;
  if (Array.isArray(org_ids) && org_ids.length) {
    const placeholders = org_ids.map(() => '?').join(',');
    targetOrgs = db.prepare(`SELECT id, name, contact_email, trial_ends_at FROM organizations WHERE id IN (${placeholders})`).all(...org_ids);
  } else {
    targetOrgs = db.prepare(`SELECT id, name, contact_email, trial_ends_at FROM organizations`).all();
  }

  targetOrgs = targetOrgs.filter((o) => o.contact_email);

  if (preview) {
    const first = targetOrgs[0];
    if (!first) return res.json({ subject: '', html: '', recipients: [] });
    const tpl = template_key ? getTemplate(template_key, first) : null;
    return res.json({
      subject: tpl?.subject || custom_subject || '(no subject)',
      html: tpl?.html || (custom_message ? `<p>${custom_message}</p>` : ''),
      recipients: targetOrgs.map((o) => ({ id: o.id, name: o.name, email: o.contact_email }))
    });
  }

  const results = { sent: 0, failed: [] };
  for (const org of targetOrgs) {
    try {
      let subject, html;
      if (template_key) {
        const tpl = getTemplate(template_key, org);
        if (!tpl) { results.failed.push({ org: org.name, reason: 'Unknown template' }); continue; }
        subject = tpl.subject;
        html = tpl.html;
      } else {
        subject = custom_subject || 'Message from OnFleet';
        html = `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a2b42">${String(custom_message).replace(/\n/g, '</p><p style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#1a2b42;margin:0 0 12px">').replace(/</g, (m, i) => i === 0 ? m : m)}</p>`;
      }
      await sendHtmlEmail(org.contact_email, subject, html);
      results.sent++;
    } catch (err) {
      results.failed.push({ org: org.name, email: org.contact_email, reason: err.message });
    }
  }

  logAudit(req.user.id, 'admin.fleet_owner.email', 'organizations', null,
    { template_key, org_ids, sent: results.sent, failed: results.failed.length }, req.ip);

  res.json(results);
});

// ── Paystack sync helpers ─────────────────────────────────────────────────────

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function paystackHeaders() {
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
}

function ensureFleetWalletAdmin(organizationId) {
  db.prepare('INSERT OR IGNORE INTO fleet_wallets (organization_id) VALUES (?)').run(organizationId);
}

function creditFleetWalletAdmin(organizationId, grossAmountZAR, riderId, reference) {
  const fee = +(grossAmountZAR * 0.035 + 1).toFixed(2);
  const net = +(grossAmountZAR - fee).toFixed(2);
  ensureFleetWalletAdmin(organizationId);
  db.transaction(() => {
    if (reference) {
      const dup = db.prepare('SELECT id FROM fleet_wallet_transactions WHERE paystack_reference = ? AND organization_id = ?').get(reference, organizationId);
      if (dup) return;
    }
    db.prepare('UPDATE fleet_wallets SET balance = balance + ?, total_collected = total_collected + ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?')
      .run(net, net, organizationId);
    db.prepare(`INSERT INTO fleet_wallet_transactions (organization_id, type, amount, fee_amount, net_amount, description, paystack_reference, rider_user_id, available_at)
      VALUES (?,?,?,?,?,?,?,?, datetime('now', '+48 hours'))`)
      .run(organizationId, 'credit', grossAmountZAR, fee, net, 'Weekly rider rental payment (admin sync)', reference || null, riderId || null);
  })();
}

function applyPaymentToScheduleAdmin(agreementId, amountZAR) {
  const agreement = db.prepare('SELECT status FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('Agreement discontinued');
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? AND status != 'paid' AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  let remaining = amountZAR;
  const upd = db.prepare('UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?');
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

// Resolve agreementId + orgId + riderId from a Paystack transaction object.
// Returns null values for fields that cannot be resolved.
function resolvePaystackTxnScope(txn, hintOrgId) {
  const meta = txn.metadata || {};
  const customerCode = txn.customer?.customer_code;
  const subscriptionCode = txn.subscription?.subscription_code;

  let agreementId = Number(meta.agreement_id) || null;
  let orgId = Number(meta.organization_id) || hintOrgId || null;
  let riderId = Number(meta.rider_user_id) || null;

  if (agreementId) {
    const ag = db.prepare('SELECT id, user_id FROM agreements WHERE id = ?').get(agreementId);
    if (!ag) agreementId = null;
    else if (!riderId) riderId = ag.user_id;
  }

  if ((!agreementId || !orgId) && customerCode) {
    const sub = subscriptionCode
      ? db.prepare('SELECT agreement_id, organization_id, rider_user_id FROM rider_subscriptions WHERE paystack_subscription_code = ? LIMIT 1').get(subscriptionCode)
      : db.prepare('SELECT agreement_id, organization_id, rider_user_id FROM rider_subscriptions WHERE paystack_customer_code = ? ORDER BY id DESC LIMIT 1').get(customerCode);
    if (sub) {
      if (!agreementId && sub.agreement_id) agreementId = sub.agreement_id;
      if (!orgId && sub.organization_id) orgId = sub.organization_id;
      if (!riderId && sub.rider_user_id) riderId = sub.rider_user_id;
    }
  }

  if (!orgId && agreementId) {
    const scope = db.prepare('SELECT b.organization_id FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = ?').get(agreementId);
    if (scope?.organization_id) orgId = scope.organization_id;
  }

  if (!riderId && agreementId) {
    const ag = db.prepare('SELECT user_id FROM agreements WHERE id = ?').get(agreementId);
    if (ag) riderId = ag.user_id;
  }

  return { agreementId, orgId, riderId };
}

// Insert payment row + apply to schedule + credit wallet for a verified Paystack transaction.
// Returns { result, payment_id } where result is 'synced' or 'already_recorded'.
function replayPaystackTxn(txn, hintOrgId, actorUserId, ip) {
  const reference = txn.reference;
  const grossAmountZAR = (txn.amount || 0) / 100;
  if (grossAmountZAR <= 0) throw new Error('Zero-amount transaction');

  // Only a prior Paystack payment (matched by paystack_reference) counts as already recorded.
  // A manual EFT entry with a coincidentally identical reference is a separate payment and
  // must not block this Paystack record from being created and crediting the wallet.
  const existing = db.prepare('SELECT id, status FROM payments WHERE paystack_reference = ?').get(reference);
  if (existing && existing.status === 'success') return { result: 'already_recorded', payment_id: existing.id };

  const { agreementId, orgId, riderId } = resolvePaystackTxnScope(txn, hintOrgId);
  if (!agreementId) throw new Error('Could not resolve agreement_id for this transaction');

  const agreement = db.prepare('SELECT status FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');

  // Use same fee formula as creditFleetWalletAdmin so the payment record matches the wallet credit.
  const fee = +(grossAmountZAR * 0.035 + 1).toFixed(2);
  const net = +(grossAmountZAR - fee).toFixed(2);
  // Use the actual Paystack payment date so payments appear correctly in history.
  const paidAt = txn.paid_at || txn.created_at || new Date().toISOString();

  let paymentId;
  db.transaction(() => {
    const alreadyPs = db.prepare('SELECT id FROM payments WHERE paystack_reference = ?').get(reference);
    if (alreadyPs) { paymentId = alreadyPs.id; return; }

    const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status, fee_amount, net_amount, paid_at, notes)
      VALUES (?,?,?,'ZAR','paystack',?,?,'success',?,?,?,'Synced from Paystack admin tool')`)
      .run(agreementId, riderId, grossAmountZAR, reference, reference, fee, net, paidAt);
    paymentId = info.lastInsertRowid;
  })();

  if (agreement.status !== 'discontinued') {
    try { applyPaymentToScheduleAdmin(agreementId, grossAmountZAR); } catch (e) {
      console.error(`[admin sync] schedule apply error for agreement ${agreementId}:`, e.message);
    }
  }

  if (orgId) creditFleetWalletAdmin(orgId, grossAmountZAR, riderId, reference);

  if (actorUserId) {
    logAudit(actorUserId, 'admin.paystack.replay_charge', 'payments', paymentId,
      { reference, agreement_id: agreementId, org_id: orgId, amount: grossAmountZAR }, ip);
  }

  return { result: 'synced', payment_id: paymentId, amount: grossAmountZAR, agreement_id: agreementId, org_id: orgId };
}

// ── POST /admin/paystack/diagnose ─────────────────────────────────────────────
// Returns raw Paystack data for a subscription or customer code so mismatches
// can be identified without guessing. Safe read-only endpoint.
router.post('/paystack/diagnose', superadminOnly, async (req, res) => {
  const { subscription_code, customer_code } = req.body || {};
  if (!subscription_code && !customer_code) {
    return res.status(400).json({ error: 'Provide subscription_code or customer_code' });
  }
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not configured' });

  const out = {};
  try {
    if (subscription_code) {
      const { data } = await axios.get(`${PAYSTACK_BASE_URL}/subscription/${encodeURIComponent(subscription_code)}`, {
        headers: paystackHeaders()
      });
      const sub = data.data;
      out.subscription = {
        code: sub?.subscription_code,
        status: sub?.status,
        amount: sub?.amount,
        customer_code: sub?.customer?.customer_code,
        customer_email: sub?.customer?.email,
        plan_code: sub?.plan?.plan_code,
        invoice_count: (sub?.invoices || []).length,
        invoices: (sub?.invoices || []).map((inv) => ({
          reference: inv.transaction?.reference,
          status: inv.transaction?.status,
          amount: inv.transaction?.amount,
          paid_at: inv.transaction?.paid_at
        }))
      };
      // Check if we can find this customer's email in our DB
      if (sub?.customer?.email) {
        const user = db.prepare('SELECT id, email, full_name, role FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1').get(sub.customer.email);
        out.local_user_match = user || null;
      }
      // Also fetch transactions for this customer
      if (sub?.customer?.customer_code) {
        try {
          const { data: txnData } = await axios.get(`${PAYSTACK_BASE_URL}/transaction`, {
            params: { customer: sub.customer.customer_code, perPage: 10, status: 'success' },
            headers: paystackHeaders()
          });
          out.recent_transactions = (txnData.data || []).map((t) => ({
            reference: t.reference,
            amount: t.amount,
            status: t.status,
            paid_at: t.paid_at,
            channel: t.channel
          }));
        } catch (e) {
          out.transaction_fetch_error = e.message;
        }
      }
    }
    if (customer_code) {
      const { data: txnData } = await axios.get(`${PAYSTACK_BASE_URL}/transaction`, {
        params: { customer: customer_code, perPage: 10, status: 'success' },
        headers: paystackHeaders()
      });
      out.transactions_by_customer = (txnData.data || []).map((t) => ({
        reference: t.reference,
        amount: t.amount,
        status: t.status,
        paid_at: t.paid_at
      }));
    }
    res.json(out);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message, paystack_response: err.response?.data });
  }
});

// ── POST /admin/paystack/replay-charge ────────────────────────────────────────
router.post('/paystack/replay-charge', superadminOnly, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not configured' });

  try {
    const { data: psResp } = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: paystackHeaders()
    });

    if (!psResp.status || psResp.data?.status !== 'success') {
      return res.status(400).json({ error: 'Transaction is not successful on Paystack', ps_status: psResp.data?.status });
    }

    const result = replayPaystackTxn(psResp.data, null, req.user.id, req.ip);
    res.json(result);
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Transaction not found on Paystack' });
    console.error('[admin] replay-charge error:', err.message);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Fetch all successful Paystack transactions for a customer code, handling pagination.
async function fetchCustomerTxns(customerCode) {
  const txns = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const { data: psResp } = await axios.get(`${PAYSTACK_BASE_URL}/transaction`, {
      params: { customer: customerCode, perPage: 100, page, status: 'success' },
      headers: paystackHeaders()
    });
    const batch = psResp.data || [];
    txns.push(...batch);
    hasMore = batch.length === 100;
    page++;
  }
  return txns;
}

// All configured rider plan codes (mirrors RIDER_PLAN_AMOUNTS in payments.js).
const RIDER_PLAN_AMOUNTS = [500, 650, 700, 750, 800, 850, 1000, 1200];
function allRiderPlanCodes() {
  return RIDER_PLAN_AMOUNTS.map((amt) => process.env[`PAYSTACK_FLEET_PLAN_${amt}`]).filter(Boolean);
}

// Fetch every Paystack subscription for a given plan code, paginated.
async function fetchPlanSubscriptions(planCode) {
  const all = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const { data: resp } = await axios.get(`${PAYSTACK_BASE_URL}/subscription`, {
      params: { plan: planCode, perPage: 100, page },
      headers: paystackHeaders()
    });
    const batch = resp.data || [];
    all.push(...batch);
    hasMore = batch.length === 100;
    page++;
  }
  return all;
}

// Given a Paystack subscription object and a target org, find the matching
// local rider + agreement by matching the customer's email to a user in our DB
// who has an agreement on a bike belonging to this org.
function resolveSubscriptionToAgreement(psSub, orgId) {
  const email = psSub.customer?.email;
  if (!email) return null;
  const user = db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1').get(email);
  if (!user) return null;
  const ag = db.prepare(`SELECT a.id FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    WHERE a.user_id = ? AND b.organization_id = ? AND a.status IN ('active','paused','defaulted','completed')
    ORDER BY a.id DESC LIMIT 1`).get(user.id, orgId);
  return ag ? { riderId: user.id, agreementId: ag.id } : null;
}

// Process all invoices from a Paystack subscription object.
// Paystack returns inv.transaction as either a full object OR a bare integer ID.
// We accept either, fetching the full transaction from Paystack when needed.
async function processSubscriptionInvoices(psSub, orgId, riderId, agreementId, actorUserId, ip, results) {
  // Filter by invoice status OR nested transaction status — don't require both.
  const invoices = (psSub.invoices || []).filter((inv) =>
    inv.status === 'success' || inv.transaction?.status === 'success'
  );
  results.checked += invoices.length;

  for (const inv of invoices) {
    let txn = (inv.transaction && typeof inv.transaction === 'object') ? inv.transaction : null;

    // inv.transaction is a bare integer ID — fetch the full transaction from Paystack.
    if (!txn && inv.transaction) {
      try {
        const { data: txnResp } = await axios.get(`${PAYSTACK_BASE_URL}/transaction/${inv.transaction}`, {
          headers: paystackHeaders()
        });
        txn = txnResp.data;
      } catch (e) {
        results.errors.push({ invoice_code: inv.invoice_code, reason: `Could not fetch transaction ${inv.transaction}: ${e.message}` });
        results.skipped++;
        continue;
      }
    }

    if (!txn?.reference) { results.skipped++; continue; }

    // Inject subscription + resolved IDs so resolvePaystackTxnScope can find the agreement.
    if (!txn.subscription) txn.subscription = { subscription_code: psSub.subscription_code };
    if (!txn.metadata) txn.metadata = {};
    if (agreementId && !txn.metadata.agreement_id) txn.metadata.agreement_id = agreementId;
    if (riderId && !txn.metadata.rider_user_id) txn.metadata.rider_user_id = riderId;
    if (orgId && !txn.metadata.organization_id) txn.metadata.organization_id = orgId;

    try {
      const outcome = replayPaystackTxn(txn, orgId, actorUserId, ip);
      if (outcome.result === 'already_recorded') results.skipped++;
      else results.synced++;
    } catch (err) {
      results.errors.push({ reference: txn.reference, reason: err.message });
      results.skipped++;
    }
  }
}

// Fetch a single Paystack subscription by code and process its invoices.
async function syncOneSubscription(subCode, orgId, actorUserId, ip, results, seenSubCodes, hintAgreementId = null) {
  if (seenSubCodes.has(subCode)) return;
  seenSubCodes.add(subCode);

  if (!results.debug.subscriptions) results.debug.subscriptions = [];
  const diag = { code: subCode, ps_found: false, invoice_count: 0, txn_count: 0, customer_code: null, customer_email: null, email_match: null };
  results.debug.subscriptions.push(diag);

  const { data: subResp } = await axios.get(`${PAYSTACK_BASE_URL}/subscription/${encodeURIComponent(subCode)}`, {
    headers: paystackHeaders()
  });
  const psSub = subResp.data;
  if (!psSub) { diag.error = 'Paystack returned null for this subscription code'; return; }

  diag.ps_found = true;
  diag.ps_status = psSub.status;
  diag.amount = psSub.amount;
  diag.customer_code = psSub.customer?.customer_code || null;
  diag.customer_email = psSub.customer?.email || null;
  diag.invoice_count = (psSub.invoices || []).length;
  diag.plan_code = psSub.plan?.plan_code || null;

  // Check if email matches a local user
  if (diag.customer_email) {
    const user = db.prepare('SELECT id, full_name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1').get(diag.customer_email);
    diag.email_match = user ? { id: user.id, name: user.full_name } : null;
  }

  // Backfill customer code if we don't have it.
  const localRow = db.prepare('SELECT id, paystack_customer_code, rider_user_id, agreement_id FROM rider_subscriptions WHERE paystack_subscription_code = ?').get(subCode);
  const customerCode = psSub.customer?.customer_code;
  if (localRow && !localRow.paystack_customer_code && customerCode) {
    db.prepare('UPDATE rider_subscriptions SET paystack_customer_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(customerCode, localRow.id);
  }

  // Resolve org match via email if we don't have a local row.
  // Fall back to hintAgreementId when email lookup fails (Paystack email ≠ OnFleet email).
  let riderId = localRow?.rider_user_id || null;
  let agreementId = localRow?.agreement_id || null;
  if (!riderId || !agreementId) {
    const match = resolveSubscriptionToAgreement(psSub, orgId);
    if (match) { riderId = riderId || match.riderId; agreementId = agreementId || match.agreementId; }
  }
  if (!agreementId && hintAgreementId) {
    agreementId = hintAgreementId;
    if (!riderId) {
      const ag = db.prepare('SELECT user_id FROM agreements WHERE id = ?').get(agreementId);
      if (ag) riderId = ag.user_id;
    }
    diag.hint_agreement_used = true;
  }
  diag.rider_id = riderId;
  diag.agreement_id = agreementId;

  if (!localRow && riderId && agreementId) {
    db.prepare(`INSERT OR IGNORE INTO rider_subscriptions
      (organization_id, rider_user_id, agreement_id, paystack_subscription_code, paystack_customer_code, plan_code, weekly_amount, status)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(orgId, riderId, agreementId, subCode, customerCode || null, psSub.plan?.plan_code || null,
        (psSub.amount || 0) / 100, psSub.status === 'active' ? 'active' : 'cancelled');
  }

  await processSubscriptionInvoices(psSub, orgId, riderId, agreementId, actorUserId, ip, results);

  // Also sweep all customer transactions to catch charges not on the invoice list.
  if (customerCode) {
    try {
      const txns = await fetchCustomerTxns(customerCode);
      diag.txn_count = txns.length;
      results.checked += txns.length;
      for (const txn of txns) {
        if (!txn.subscription) txn.subscription = { subscription_code: subCode };
        if (!txn.metadata) txn.metadata = {};
        if (riderId && !txn.metadata.rider_user_id) txn.metadata.rider_user_id = riderId;
        if (agreementId && !txn.metadata.agreement_id) txn.metadata.agreement_id = agreementId;
        if (orgId && !txn.metadata.organization_id) txn.metadata.organization_id = orgId;
        try {
          const outcome = replayPaystackTxn(txn, orgId, actorUserId, ip);
          if (outcome.result === 'already_recorded') results.skipped++;
          else results.synced++;
        } catch (err) {
          results.errors.push({ reference: txn.reference, reason: err.message });
          results.skipped++;
        }
      }
    } catch (e) {
      diag.txn_fetch_error = e.message;
    }
  } else {
    diag.warning = 'No customer_code on Paystack subscription — cannot fetch transaction list';
  }
}

// ── POST /admin/paystack/sync-org ─────────────────────────────────────────────
// Body: { org_id, subscription_codes?: string[], hint_agreement_number?: string }
// Pass subscription_codes to sync specific subscriptions directly.
// Pass hint_agreement_number (e.g. "OF-2026-895786") when the Paystack customer
// email doesn't match OnFleet records — bypasses email-based agreement resolution.
router.post('/paystack/sync-org', superadminOnly, async (req, res) => {
  const orgId = Number(req.body?.org_id);
  if (!Number.isInteger(orgId) || orgId <= 0) return res.status(400).json({ error: 'org_id is required' });

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not configured' });

  // Resolve optional agreement hint so the caller can bypass email-match failures.
  let hintAgreementId = null;
  const hintAgreementNumber = req.body?.hint_agreement_number ? String(req.body.hint_agreement_number).trim() : null;
  if (hintAgreementNumber) {
    const ag = db.prepare('SELECT id FROM agreements WHERE agreement_number = ?').get(hintAgreementNumber);
    if (ag) hintAgreementId = ag.id;
    else return res.status(400).json({ error: `Agreement not found: ${hintAgreementNumber}` });
  }

  const results = { checked: 0, synced: 0, skipped: 0, errors: [], debug: {} };
  const seenSubCodes = new Set();

  // ── Path 0: explicit subscription codes passed by the caller ──────────────
  const explicitCodes = Array.isArray(req.body?.subscription_codes)
    ? req.body.subscription_codes.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (explicitCodes.length) {
    results.debug.explicit_codes = explicitCodes;
    for (const code of explicitCodes) {
      try {
        await syncOneSubscription(code, orgId, req.user.id, req.ip, results, seenSubCodes, hintAgreementId);
      } catch (err) {
        results.errors.push({ subscription_code: code, reason: err.message });
      }
    }
    logAudit(req.user.id, 'admin.paystack.sync_org', 'organizations', orgId, results, req.ip);
    return res.json(results);
  }

  // ── Path 1: rider_subscriptions rows with Paystack codes ──────────────────
  const localSubs = db.prepare(`SELECT * FROM rider_subscriptions
    WHERE organization_id = ? AND (paystack_customer_code IS NOT NULL OR paystack_subscription_code IS NOT NULL)`).all(orgId);
  results.debug.local_sub_rows = localSubs.length;

  for (const sub of localSubs) {
    if (sub.paystack_subscription_code) {
      try {
        await syncOneSubscription(sub.paystack_subscription_code, orgId, req.user.id, req.ip, results, seenSubCodes);
      } catch (err) {
        results.errors.push({ subscription_code: sub.paystack_subscription_code, reason: err.message });
      }
      continue;
    }
    // Customer code only — no subscription code
    if (sub.paystack_customer_code) {
      seenSubCodes.add(`cus:${sub.paystack_customer_code}`);
      try {
        const txns = await fetchCustomerTxns(sub.paystack_customer_code);
        results.checked += txns.length;
        for (const txn of txns) {
          try {
            const outcome = replayPaystackTxn(txn, orgId, req.user.id, req.ip);
            if (outcome.result === 'already_recorded') results.skipped++;
            else results.synced++;
          } catch (err) {
            results.errors.push({ reference: txn.reference, reason: err.message });
            results.skipped++;
          }
        }
      } catch (err) {
        results.errors.push({ customer_code: sub.paystack_customer_code, reason: err.message });
      }
    }
  }

  // ── Path 2: plan-code sweep ───────────────────────────────────────────────
  const planCodes = allRiderPlanCodes();
  results.debug.plan_codes_found = planCodes;

  for (const planCode of planCodes) {
    let psSubs;
    try {
      psSubs = await fetchPlanSubscriptions(planCode);
    } catch (err) {
      results.errors.push({ plan_code: planCode, reason: err.message });
      continue;
    }
    results.debug[`plan_${planCode}_subs`] = psSubs.length;

    for (const psSub of psSubs) {
      if (seenSubCodes.has(psSub.subscription_code)) continue;
      const match = resolveSubscriptionToAgreement(psSub, orgId);
      if (!match) continue;
      try {
        await syncOneSubscription(psSub.subscription_code, orgId, req.user.id, req.ip, results, seenSubCodes);
      } catch (err) {
        results.errors.push({ subscription_code: psSub.subscription_code, reason: err.message });
      }
    }
  }

  logAudit(req.user.id, 'admin.paystack.sync_org', 'organizations', orgId, results, req.ip);
  res.json(results);
});

// ── GET /admin/org-agreements ─────────────────────────────────────────────────
// Returns active/defaulted/paused agreements for an org (for dropdowns).
router.get('/org-agreements', superadminOnly, (req, res) => {
  const orgId = Number(req.query.org_id);
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const agreements = db.prepare(`
    SELECT a.id, a.agreement_no, a.status, a.created_at,
           u.id as rider_id, u.full_name as rider_name, u.email as rider_email,
           b.registration as bike_reg
    FROM agreements a
    JOIN users u ON u.id = a.user_id
    JOIN bikes b ON b.id = a.bike_id
    WHERE b.organization_id = ?
      AND a.status IN ('active','paused','defaulted')
    ORDER BY CASE WHEN a.status = 'active' THEN 0 ELSE 1 END, a.id DESC
  `).all(orgId);
  res.json(agreements);
});

// ── GET /admin/agreement-schedule ─────────────────────────────────────────────
// Returns all payment schedule weeks for an agreement (for the payment modal).
router.get('/agreement-schedule', superadminOnly, (req, res) => {
  const agreementId = Number(req.query.agreement_id);
  if (!agreementId) return res.status(400).json({ error: 'agreement_id required' });
  const weeks = db.prepare(`
    SELECT id, week_number, due_date, amount_due, amount_paid, status, paid_at
    FROM payment_schedules
    WHERE agreement_id = ?
    ORDER BY week_number ASC
  `).all(agreementId);
  res.json(weeks);
});

// ── POST /admin/record-paystack-payment ───────────────────────────────────────
// Manually record a Paystack payment, apply it to a contract schedule, and
// credit the fleet wallet.  Body: { org_id, agreement_id, amount, reference?,
// paid_at?, schedule_week_ids? }
router.post('/record-paystack-payment', superadminOnly, (req, res) => {
  const { org_id, agreement_id, amount, reference, paid_at, schedule_week_ids } = req.body;

  if (!agreement_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'agreement_id and a positive amount are required' });
  }

  const grossAmountZAR = Number(amount);
  const agreement = db.prepare(`
    SELECT a.id, a.status, a.user_id, b.organization_id
    FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = ?
  `).get(Number(agreement_id));
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

  const orgId = Number(org_id) || agreement.organization_id;
  const riderId = agreement.user_id;
  const ref = (reference || '').trim() || `ADMIN-PS-${Date.now()}`;
  const paymentDate = paid_at ? new Date(paid_at).toISOString() : new Date().toISOString();

  const dupCheck = db.prepare('SELECT id FROM payments WHERE paystack_reference = ? OR reference = ?').get(ref, ref);
  if (dupCheck) return res.status(409).json({ error: `Reference already exists: ${ref}` });

  const fee = +(grossAmountZAR * 0.035 + 1).toFixed(2);
  const net = +(grossAmountZAR - fee).toFixed(2);

  let paymentId;
  db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO payments
        (agreement_id, user_id, amount, currency, method, reference, paystack_reference,
         status, fee_amount, net_amount, paid_at, notes)
      VALUES (?,?,?,'ZAR','paystack',?,?,'success',?,?,?,'Admin-recorded Paystack payment')
    `).run(Number(agreement_id), riderId, grossAmountZAR, ref, ref, fee, net, paymentDate);
    paymentId = info.lastInsertRowid;

    const weekIds = Array.isArray(schedule_week_ids)
      ? schedule_week_ids.map(Number).filter(Boolean)
      : [];
    if (weekIds.length) {
      const upd = db.prepare(
        'UPDATE payment_schedules SET amount_paid=?, status=?, paid_at=? WHERE id=? AND agreement_id=?'
      );
      let remaining = grossAmountZAR;
      for (const wid of weekIds) {
        if (remaining <= 0) break;
        const row = db.prepare('SELECT * FROM payment_schedules WHERE id=? AND agreement_id=?')
          .get(wid, Number(agreement_id));
        if (!row || row.status === 'paid' || row.status === 'waived') continue;
        const owe = +(row.amount_due - row.amount_paid).toFixed(2);
        const apply = Math.min(remaining, owe);
        const newPaid = +(row.amount_paid + apply).toFixed(2);
        const newStatus = newPaid >= row.amount_due ? 'paid' : 'partial';
        upd.run(newPaid, newStatus, newStatus === 'paid' ? paymentDate : (row.paid_at || null),
          wid, Number(agreement_id));
        remaining = +(remaining - apply).toFixed(2);
      }
    }
  })();

  if (agreement.status !== 'discontinued') {
    const weekIds = Array.isArray(schedule_week_ids) ? schedule_week_ids : [];
    if (weekIds.length) {
      recalcScheduleStatuses(Number(agreement_id));
    } else {
      try { applyPaymentToScheduleAdmin(Number(agreement_id), grossAmountZAR); } catch (e) {
        console.error('[admin record payment] schedule apply error:', e.message);
      }
    }
  }

  creditFleetWalletAdmin(orgId, grossAmountZAR, riderId, ref);

  logAudit(req.user.id, 'admin.record_paystack_payment', 'payments', paymentId,
    { agreement_id, org_id: orgId, amount: grossAmountZAR, reference: ref, paid_at: paymentDate }, req.ip);

  res.json({ success: true, payment_id: paymentId, amount: grossAmountZAR, reference: ref, net_to_wallet: net });
});

module.exports = router;
