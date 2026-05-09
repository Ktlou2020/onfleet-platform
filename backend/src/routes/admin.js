const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { generateStrategicReport } = require('../services/strategicReport');
const { sendNotification, detectEmailProvider } = require('../services/notifier');

const router = express.Router();
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
  let sql = `SELECT id, email, full_name, role, status
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

router.get('/dashboard', (req, res) => {
  const stats = {
    riders: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'rider' AND deleted_at IS NULL`).get().c,
    admins: db.prepare(`SELECT COUNT(*) c FROM users WHERE role IN ('admin','superadmin') AND deleted_at IS NULL`).get().c,
    active_agreements: db.prepare(`SELECT COUNT(*) c FROM agreements WHERE status = 'active'`).get().c,
    completed_agreements: db.prepare(`SELECT COUNT(*) c FROM agreements WHERE status = 'completed'`).get().c,
    bikes_available: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'available'`).get().c,
    bikes_allocated: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'allocated'`).get().c,
    bikes_maintenance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'maintenance'`).get().c,
    pending_applications: db.prepare(`SELECT COUNT(*) c FROM applications WHERE status IN ('submitted','under_review')`).get().c,
    pending_kyc: db.prepare(`SELECT COUNT(*) c FROM application_documents WHERE status = 'uploaded'`).get().c,
    revenue_total: db.prepare(`SELECT COALESCE(SUM(COALESCE(net_amount, amount)),0) s FROM payments WHERE status = 'success'`).get().s,
    revenue_30d: db.prepare(`SELECT COALESCE(SUM(COALESCE(net_amount, amount)),0) s FROM payments WHERE status = 'success' AND paid_at >= datetime('now','-30 days')`).get().s,
    overdue_amount: db.prepare(`SELECT COALESCE(SUM(amount_due - amount_paid),0) s FROM payment_schedules WHERE status = 'overdue'`).get().s,
    overdue_count: db.prepare(`SELECT COUNT(DISTINCT agreement_id) c FROM payment_schedules WHERE status = 'overdue'`).get().c,
    upcoming_services: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE next_service_date IS NOT NULL AND next_service_date <= date('now','+14 days') AND status = 'allocated'`).get().c,
    expiring_insurance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE insurance_expiry IS NOT NULL AND insurance_expiry <= date('now','+30 days')`).get().c,
    expiring_license_disc: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE license_disc_expiry IS NOT NULL AND license_disc_expiry <= date('now','+30 days')`).get().c
  };
  const weekly = db.prepare(`SELECT strftime('%Y-%W', paid_at) week, COALESCE(SUM(COALESCE(net_amount, amount)),0) total
    FROM payments WHERE status = 'success' AND paid_at >= datetime('now','-90 days')
    GROUP BY week ORDER BY week`).all();
  res.json({ stats, weekly_revenue: weekly });
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
  const sql = `SELECT id, email, full_name, phone, role, status, country_of_origin, avatar_url, created_at
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
