const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpers');

const router = express.Router();

router.post('/', authRequired, (req, res) => {
  const b = req.body;
  const info = db.prepare(`INSERT INTO applications
    (user_id, preferred_bike_id, employment_status, monthly_income, delivery_platforms,
     has_riding_experience, years_riding, has_drivers_license, references_json, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'submitted')`).run(
      req.user.id, b.preferred_bike_id || null, b.employment_status || null,
      b.monthly_income || null, (b.delivery_platforms || []).join(','),
      b.has_riding_experience ? 1 : 0, b.years_riding || null,
      b.has_drivers_license ? 1 : 0, JSON.stringify(b.references || []));
  logAudit(req.user.id, 'application.submit', 'applications', info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid });
});

router.get('/mine', authRequired, (req, res) => {
  const apps = db.prepare(`SELECT a.*, b.make, b.model FROM applications a
                           LEFT JOIN bikes b ON b.id = a.preferred_bike_id
                           WHERE a.user_id = ? ORDER BY a.submitted_at DESC`).all(req.user.id);
  res.json({ applications: apps });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const where = status ? 'WHERE a.status = ?' : '';
  const sql = `SELECT a.*, u.full_name, u.email, u.phone, b.make, b.model FROM applications a
               JOIN users u ON u.id = a.user_id
               LEFT JOIN bikes b ON b.id = a.preferred_bike_id
               ${where} ORDER BY a.submitted_at DESC`;
  const apps = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ applications: apps });
});

router.get('/:id', authRequired, adminOnly, (req, res) => {
  const app = db.prepare(`SELECT a.*, u.full_name, u.email, u.phone, u.id_number, u.address,
                          u.city, u.province FROM applications a
                          JOIN users u ON u.id = a.user_id WHERE a.id = ?`).get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const docs = db.prepare(`SELECT id, doc_type, status, original_name FROM kyc_documents WHERE user_id = ?`)
                  .all(app.user_id);
  res.json({ application: app, kyc_documents: docs });
});

// Approve application — allocate bike & create agreement + schedule
router.post('/:id/approve', authRequired, adminOnly, (req, res) => {
  const { bike_id, weekly_amount, total_weeks, start_date } = req.body;
  if (!bike_id || !weekly_amount || !start_date)
    return res.status(400).json({ error: 'bike_id, weekly_amount, start_date required' });

  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(bike_id);
  if (!bike) return res.status(404).json({ error: 'Bike not found' });
  if (bike.status !== 'available') return res.status(400).json({ error: 'Bike not available' });

  const weeks = total_weeks || 78;
  const total = +(weekly_amount * weeks).toFixed(2);
  const endDate = addDays(start_date, weeks * 7);
  const agreementNo = generateAgreementNo();

  const tx = db.transaction(() => {
    db.prepare(`UPDATE applications SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
                WHERE id = ?`).run(req.user.id, req.params.id);
    db.prepare(`UPDATE bikes SET status = 'allocated' WHERE id = ?`).run(bike_id);
    const info = db.prepare(`INSERT INTO agreements
      (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount,
       start_date, end_date, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`).run(
        agreementNo, app.user_id, bike_id, app.id, weekly_amount, weeks, total,
        start_date, endDate, req.user.id);
    buildPaymentSchedule(info.lastInsertRowid, weekly_amount, weeks, start_date);
    return info.lastInsertRowid;
  });
  const agreementId = tx();
  logAudit(req.user.id, 'application.approve', 'applications', +req.params.id, { agreementId });
  res.json({ ok: true, agreement_id: agreementId, agreement_no: agreementNo });
});

router.post('/:id/reject', authRequired, adminOnly, (req, res) => {
  db.prepare(`UPDATE applications SET status = 'rejected', rejection_reason = ?,
              reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.body.reason || null, req.user.id, req.params.id);
  logAudit(req.user.id, 'application.reject', 'applications', +req.params.id);
  res.json({ ok: true });
});

module.exports = router;
