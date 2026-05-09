const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpers');
const { generateStrategicReport } = require('../services/strategicReport');

const router = express.Router();
router.use(authRequired, adminOnly);

function superadminOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin access required' });
  next();
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
