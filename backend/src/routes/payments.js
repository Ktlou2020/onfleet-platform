const express = require('express');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');

const router = express.Router();
const PAYSTACK_BASE = 'https://api.paystack.co';

function applyPaymentToSchedule(agreementId, amountZAR) {
  // Apply to oldest unpaid (or partial) week first
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ?
                               AND status != 'paid' AND status != 'waived'
                               ORDER BY week_number ASC`).all(agreementId);
  let remaining = amountZAR;
  const upd = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`);
  for (const s of schedule) {
    if (remaining <= 0) break;
    const owe = +(s.amount_due - s.amount_paid).toFixed(2);
    const apply = Math.min(remaining, owe);
    const newPaid = +(s.amount_paid + apply).toFixed(2);
    const status = newPaid >= s.amount_due ? 'paid' : 'partial';
    const paidAt = status === 'paid' ? new Date().toISOString() : s.paid_at;
    upd.run(newPaid, status, paidAt, s.id);
    remaining = +(remaining - apply).toFixed(2);
  }
  recalcScheduleStatuses(agreementId);
  return remaining; // overflow (credit)
}

// Initialize Paystack transaction
router.post('/paystack/init', authRequired, async (req, res) => {
  const { agreement_id, amount } = req.body;
  const ag = db.prepare('SELECT * FROM agreements WHERE id = ? AND user_id = ?').get(agreement_id, req.user.id);
  if (!ag) return res.status(404).json({ error: 'Agreement not found' });

  const reference = `OF-${uuid().slice(0,12)}`;
  const amountKobo = Math.round(amount * 100);

  try {
    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email: req.user.email,
      amount: amountKobo,
      currency: 'ZAR',
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      metadata: { agreement_id, user_id: req.user.id }
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

    db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference,
                paystack_reference, status) VALUES (?,?,?,?, 'paystack', ?, ?, 'pending')`)
      .run(agreement_id, req.user.id, amount, 'ZAR', reference, reference);

    res.json({ authorization_url: resp.data.data.authorization_url, reference, access_code: resp.data.data.access_code });
  } catch (e) {
    res.status(500).json({ error: 'Paystack init failed', details: e.response?.data || e.message });
  }
});

// Verify after callback
router.get('/paystack/verify/:reference', authRequired, async (req, res) => {
  try {
    const resp = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${req.params.reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const data = resp.data.data;
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(req.params.reference);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (data.status === 'success' && payment.status !== 'success') {
      const amountZAR = data.amount / 100;
      db.prepare(`UPDATE payments SET status = 'success', paid_at = CURRENT_TIMESTAMP, amount = ? WHERE id = ?`)
        .run(amountZAR, payment.id);
      applyPaymentToSchedule(payment.agreement_id, amountZAR);
      logAudit(req.user.id, 'payment.success', 'payments', payment.id, { amount: amountZAR });
    }
    res.json({ status: data.status, amount: data.amount / 100, payment });
  } catch (e) {
    res.status(500).json({ error: 'Verify failed', details: e.response?.data || e.message });
  }
});

// Paystack webhook (server-to-server)
router.post('/paystack/webhook', express.json(), (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    const ref = event.data.reference;
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
    if (payment && payment.status !== 'success') {
      const amountZAR = event.data.amount / 100;
      db.prepare(`UPDATE payments SET status = 'success', paid_at = CURRENT_TIMESTAMP, amount = ? WHERE id = ?`)
        .run(amountZAR, payment.id);
      applyPaymentToSchedule(payment.agreement_id, amountZAR);
    }
  }
  res.sendStatus(200);
});

// Manual payment recording (admin) — EFT, cash etc.
router.post('/manual', authRequired, adminOnly, (req, res) => {
  const { agreement_id, amount, method, reference, paid_at, notes } = req.body;
  const ag = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement_id);
  if (!ag) return res.status(404).json({ error: 'Agreement not found' });

  const ref = reference || `MAN-${uuid().slice(0,10)}`;
  const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method,
                           reference, status, paid_at, recorded_by, notes)
                           VALUES (?,?,?,?, ?, ?, 'success', ?, ?, ?)`)
                  .run(agreement_id, ag.user_id, amount, 'ZAR', method || 'eft', ref,
                       paid_at || new Date().toISOString(), req.user.id, notes || null);
  applyPaymentToSchedule(agreement_id, amount);
  logAudit(req.user.id, 'payment.manual', 'payments', info.lastInsertRowid, { amount, method });
  res.json({ id: info.lastInsertRowid, reference: ref });
});

router.get('/agreement/:id', authRequired, (req, res) => {
  const ag = db.prepare('SELECT user_id FROM agreements WHERE id = ?').get(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found' });
  if (ag.user_id !== req.user.id && !['admin','superadmin'].includes(req.user.role))
    return res.status(403).json({ error: 'Forbidden' });
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? ORDER BY created_at DESC`)
                      .all(req.params.id);
  res.json({ payments });
});

router.get('/all', authRequired, adminOnly, (req, res) => {
  const payments = db.prepare(`SELECT p.*, u.full_name, u.email, a.agreement_no
                               FROM payments p JOIN users u ON u.id = p.user_id
                               JOIN agreements a ON a.id = p.agreement_id
                               ORDER BY p.created_at DESC LIMIT 500`).all();
  res.json({ payments });
});

module.exports = router;
