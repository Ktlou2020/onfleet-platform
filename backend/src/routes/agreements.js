const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');

const router = express.Router();

router.get('/mine', authRequired, (req, res) => {
  const ags = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin
                          FROM agreements a JOIN bikes b ON b.id = a.bike_id
                          WHERE a.user_id = ? ORDER BY a.created_at DESC`).all(req.user.id);
  res.json({ agreements: ags });
});

router.get('/:id', authRequired, (req, res) => {
  const ag = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
                         b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
                         b.next_service_km, b.odometer_km,
                         u.full_name, u.email, u.phone
                         FROM agreements a JOIN bikes b ON b.id = a.bike_id
                         JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found' });
  if (ag.user_id !== req.user.id && !['admin','superadmin'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });

  recalcScheduleStatuses(ag.id);

  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`)
                      .all(ag.id);
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? AND status = 'success'
                               ORDER BY paid_at DESC`).all(ag.id);

  const totalPaid = payments.reduce((s,p) => s + p.amount, 0);
  const remaining = +(ag.total_amount - totalPaid).toFixed(2);
  const weeksPaid = schedule.filter(s => s.status === 'paid').length;
  const overdue = schedule.filter(s => s.status === 'overdue').reduce((s,r) => s + (r.amount_due - r.amount_paid), 0);
  const nextDue = schedule.find(s => s.status !== 'paid' && s.status !== 'waived');
  const progressPct = +((totalPaid / ag.total_amount) * 100).toFixed(1);

  res.json({
    agreement: ag, schedule, payments,
    summary: { total_paid: +totalPaid.toFixed(2), remaining, weeks_paid: weeksPaid,
               weeks_total: ag.total_weeks, overdue: +overdue.toFixed(2),
               next_due: nextDue, progress_pct: progressPct }
  });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const sql = `SELECT a.*, u.full_name, u.email, b.make, b.model, b.registration
               FROM agreements a JOIN users u ON u.id = a.user_id
               JOIN bikes b ON b.id = a.bike_id
               ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.created_at DESC`;
  const ags = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ agreements: ags });
});

router.post('/:id/sign', authRequired, (req, res) => {
  const ag = db.prepare('SELECT * FROM agreements WHERE id = ?').get(req.params.id);
  if (!ag || ag.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE agreements SET signed_at = CURRENT_TIMESTAMP, signature_data = ? WHERE id = ?`)
    .run(req.body.signature || null, req.params.id);
  logAudit(req.user.id, 'agreement.sign', 'agreements', +req.params.id);
  res.json({ ok: true });
});

router.post('/:id/status', authRequired, adminOnly, (req, res) => {
  const { status } = req.body;
  if (!['active','completed','defaulted','cancelled','paused'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(status, req.params.id);

  // If completed, mark bike sold; if cancelled, return to available
  const ag = db.prepare('SELECT bike_id FROM agreements WHERE id = ?').get(req.params.id);
  if (status === 'completed') db.prepare(`UPDATE bikes SET status = 'sold' WHERE id = ?`).run(ag.bike_id);
  if (status === 'cancelled') db.prepare(`UPDATE bikes SET status = 'available' WHERE id = ?`).run(ag.bike_id);

  logAudit(req.user.id, 'agreement.status', 'agreements', +req.params.id, { status });
  res.json({ ok: true });
});

module.exports = router;
