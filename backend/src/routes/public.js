const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function verifyRiderPortalToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [idPart, hmacPart] = parts;
  const id = Number.parseInt(idPart, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const expected = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'onfleet-fallback')
    .update(String(id))
    .digest('hex')
    .slice(0, 32);
  if (hmacPart !== expected) return null;
  return id;
}

router.get('/rider-portal/:token', (req, res) => {
  try {
    const agreementId = verifyRiderPortalToken(req.params.token);
    if (!agreementId) return res.status(401).json({ error: 'Invalid or expired link' });

    const agreement = db.prepare(`
      SELECT a.*,
        u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
        b.make, b.model, b.registration, b.color, b.year,
        o.name AS org_name, o.slug AS org_slug, o.city AS org_city
      FROM agreements a
      JOIN users u ON u.id = a.user_id
      JOIN bikes b ON b.id = a.bike_id
      LEFT JOIN organizations o ON o.id = b.organization_id
      WHERE a.id = ?
    `).get(agreementId);

    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

    const schedule = db.prepare(
      `SELECT week_number, due_date, amount_due, amount_paid, status, paid_at
       FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`
    ).all(agreementId);

    const payments = db.prepare(
      `SELECT paid_at, amount, COALESCE(net_amount, amount) AS net_amount, fee_amount, method, reference, status
       FROM payments WHERE agreement_id = ? AND status = 'success'
       ORDER BY COALESCE(paid_at, created_at) DESC, id DESC LIMIT 25`
    ).all(agreementId);

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.net_amount || 0), 0);
    const totalDue = Number(agreement.total_amount || 0);
    const remaining = Math.max(0, +(totalDue - totalPaid).toFixed(2));
    const overdueAmount = schedule
      .filter((s) => s.status === 'overdue' || (s.status === 'partial' && s.due_date < new Date().toISOString().slice(0, 10)))
      .reduce((sum, s) => sum + Math.max(0, Number(s.amount_due) - Number(s.amount_paid || 0)), 0);
    const weeksPaid = schedule.filter((s) => s.status === 'paid').length;
    const progressPct = schedule.length > 0 ? Math.round((weeksPaid / schedule.length) * 100) : 0;

    res.json({
      agreement: {
        id: agreement.id,
        agreement_no: agreement.agreement_no,
        status: agreement.status,
        start_date: agreement.start_date,
        end_date: agreement.end_date,
        weekly_amount: agreement.weekly_amount,
        total_amount: agreement.total_amount,
        total_weeks: agreement.total_weeks,
        rider_name: agreement.rider_name,
        rider_email: agreement.rider_email,
        rider_phone: agreement.rider_phone,
        make: agreement.make,
        model: agreement.model,
        registration: agreement.registration,
        color: agreement.color,
        year: agreement.year,
        org_name: agreement.org_name,
        org_city: agreement.org_city,
      },
      schedule,
      payments,
      summary: { total_paid: totalPaid, remaining, overdue: overdueAmount, weeks_paid: weeksPaid, weeks_total: schedule.length, progress_pct: progressPct }
    });
  } catch (error) {
    res.status(500).json({ error: 'Could not load portal data' });
  }
});

module.exports = router;
