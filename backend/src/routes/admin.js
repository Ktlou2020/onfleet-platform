const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired, adminOnly);

router.get('/dashboard', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = {
    riders: db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'rider'`).get().c,
    active_agreements: db.prepare(`SELECT COUNT(*) c FROM agreements WHERE status = 'active'`).get().c,
    completed_agreements: db.prepare(`SELECT COUNT(*) c FROM agreements WHERE status = 'completed'`).get().c,
    bikes_available: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'available'`).get().c,
    bikes_allocated: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'allocated'`).get().c,
    bikes_maintenance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE status = 'maintenance'`).get().c,
    pending_applications: db.prepare(`SELECT COUNT(*) c FROM applications WHERE status = 'submitted'`).get().c,
    pending_kyc: db.prepare(`SELECT COUNT(*) c FROM kyc_documents WHERE status = 'pending'`).get().c,
    revenue_total: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status = 'success'`).get().s,
    revenue_30d: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status = 'success'
                             AND paid_at >= datetime('now','-30 days')`).get().s,
    overdue_amount: db.prepare(`SELECT COALESCE(SUM(amount_due - amount_paid),0) s FROM payment_schedules
                                WHERE status = 'overdue'`).get().s,
    overdue_count: db.prepare(`SELECT COUNT(DISTINCT agreement_id) c FROM payment_schedules
                               WHERE status = 'overdue'`).get().c,
    upcoming_services: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE next_service_date IS NOT NULL
                                   AND next_service_date <= date('now','+14 days')
                                   AND status = 'allocated'`).get().c,
    expiring_insurance: db.prepare(`SELECT COUNT(*) c FROM bikes WHERE insurance_expiry IS NOT NULL
                                    AND insurance_expiry <= date('now','+30 days')`).get().c
  };

  // Last 12 weeks revenue
  const weekly = db.prepare(`
    SELECT strftime('%Y-%W', paid_at) week, COALESCE(SUM(amount),0) total
    FROM payments WHERE status = 'success' AND paid_at >= datetime('now','-90 days')
    GROUP BY week ORDER BY week`).all();

  res.json({ stats, weekly_revenue: weekly });
});

router.get('/users', (req, res) => {
  const role = req.query.role;
  const sql = `SELECT id, email, full_name, phone, role, status, created_at FROM users
               ${role ? 'WHERE role = ?' : ''} ORDER BY created_at DESC`;
  const users = role ? db.prepare(sql).all(role) : db.prepare(sql).all();
  res.json({ users });
});

router.get('/users/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  delete user.password_hash;
  const docs = db.prepare(`SELECT * FROM kyc_documents WHERE user_id = ?`).all(req.params.id);
  const apps = db.prepare(`SELECT * FROM applications WHERE user_id = ?`).all(req.params.id);
  const ags = db.prepare(`SELECT a.*, b.make, b.model FROM agreements a
                          JOIN bikes b ON b.id = a.bike_id WHERE a.user_id = ?`).all(req.params.id);
  res.json({ user, kyc_documents: docs, applications: apps, agreements: ags });
});

router.post('/users/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active','suspended'].includes(status)) return res.status(400).json({ error: 'Invalid' });
  db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, req.params.id);
  res.json({ ok: true });
});

router.get('/audit-logs', (req, res) => {
  const logs = db.prepare(`SELECT l.*, u.full_name FROM audit_logs l
                           LEFT JOIN users u ON u.id = l.actor_id
                           ORDER BY l.created_at DESC LIMIT 200`).all();
  res.json({ logs });
});

module.exports = router;
