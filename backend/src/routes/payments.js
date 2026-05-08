const express = require('express');
const multer = require('multer');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
const PAYSTACK_BASE = 'https://api.paystack.co';

// Paystack fees: 2.9% + R1 per transaction — fee is ADDED on top of rider's payment
function calcPaystackFee(amountZAR) {
  return +(amountZAR * 0.029 + 1).toFixed(2);
}
function calcGrossAmount(amountZAR) {
  const fee = calcPaystackFee(amountZAR);
  return +(amountZAR + fee).toFixed(2);
}

function applyPaymentToSchedule(agreementId, amountZAR) {
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ?
    AND status != 'paid' AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  let remaining = amountZAR;
  const upd = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`);
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

function parseCsv(text) {
  const rows = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;
  const headers = lines.shift().split(',').map((h) => h.trim());
  for (const line of lines) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] || ''; });
    rows.push(row);
  }
  return rows;
}

function recordManualPayment({ agreement_id, amount, method, reference, paid_at, notes, recorded_by }) {
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement_id);
  if (!agreement) throw new Error('Agreement not found');
  const ref = reference || `MAN-${uuid().slice(0, 10)}`;
  const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes)
    VALUES (?,?,?,?, ?, ?, 'success', ?, ?, ?)`).run(
      agreement_id,
      agreement.user_id,
      Number(amount),
      'ZAR',
      method || 'eft',
      ref,
      paid_at || new Date().toISOString(),
      recorded_by || null,
      notes || null
    );
  applyPaymentToSchedule(agreement_id, Number(amount));
  return { id: info.lastInsertRowid, reference: ref };
}

router.post('/paystack/init', authRequired, async (req, res) => {
  const { agreement_id, amount } = req.body;
  const ag = db.prepare('SELECT * FROM agreements WHERE id = ? AND user_id = ?').get(agreement_id, req.user.id);
  if (!ag) return res.status(404).json({ error: 'Agreement not found' });

  const netAmount = Number(amount);       // what credits the rider's agreement
  const fee = calcPaystackFee(netAmount); // fee added on top
  const grossAmount = calcGrossAmount(netAmount); // total rider pays
  const reference = `OF-${uuid().slice(0, 12)}`;
  const amountKobo = Math.round(grossAmount * 100);

  try {
    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email: req.user.email,
      amount: amountKobo,
      currency: 'ZAR',
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      metadata: { agreement_id, user_id: req.user.id }
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

    db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status, fee_amount, net_amount)
      VALUES (?,?,?,?, 'paystack', ?, ?, 'pending', ?, ?)`).run(
      agreement_id, req.user.id, grossAmount, 'ZAR', reference, reference, fee, netAmount);

    return res.json({
      authorization_url: resp.data.data.authorization_url, reference, access_code: resp.data.data.access_code,
      amount: grossAmount, fee, net_amount: netAmount, base_amount: netAmount
    });
  } catch (e) {
    res.status(500).json({ error: 'Paystack init failed', details: e.response?.data || e.message });
  }
});

router.get('/paystack/verify/:reference', authRequired, async (req, res) => {
  try {
    const resp = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${req.params.reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const data = resp.data.data;
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(req.params.reference);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (data.status === 'success' && payment.status !== 'success') {
      const grossAmount = data.amount / 100;
      const netAmount = payment.net_amount || grossAmount; // use stored net, fallback to gross if old record
      const fee = calcPaystackFee(netAmount);
      db.prepare(`UPDATE payments SET status = 'success', paid_at = CURRENT_TIMESTAMP, amount = ?, fee_amount = ?, net_amount = ? WHERE id = ?`).run(grossAmount, fee, netAmount, payment.id);
      applyPaymentToSchedule(payment.agreement_id, netAmount);
      logAudit(req.user.id, 'payment.success', 'payments', payment.id, { amount: grossAmount, fee, net_amount: netAmount });
    }
    res.json({ status: data.status, amount: data.amount / 100, fee: calcPaystackFee(payment.net_amount || data.amount / 100), net_amount: payment.net_amount || data.amount / 100, payment });
  } catch (e) {
    res.status(500).json({ error: 'Verify failed', details: e.response?.data || e.message });
  }
});

router.post('/paystack/webhook', express.json(), (req, res) => {
  const event = req.body;
  if (event.event === 'charge.success') {
    const ref = event.data.reference;
    const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
    if (payment && payment.status !== 'success') {
      const grossAmount = event.data.amount / 100;
      const netAmount = payment.net_amount || grossAmount;
      const fee = calcPaystackFee(netAmount);
      db.prepare(`UPDATE payments SET status = 'success', paid_at = CURRENT_TIMESTAMP, amount = ?, fee_amount = ?, net_amount = ? WHERE id = ?`).run(grossAmount, fee, netAmount, payment.id);
      applyPaymentToSchedule(payment.agreement_id, netAmount);
    }
  }
  res.sendStatus(200);
});

router.post('/manual', authRequired, adminOnly, (req, res) => {
  try {
    const result = recordManualPayment({ ...req.body, recorded_by: req.user.id });
    logAudit(req.user.id, 'payment.manual', 'payments', result.id, { amount: req.body.amount, method: req.body.method });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/bulk-template', authRequired, adminOnly, (req, res) => {
  const csv = [
    'agreement_no,amount,method,reference,paid_at,notes',
    'OF-2026-123456,850,eft,BANKREF001,2026-05-06T08:00:00Z,Imported bank statement batch'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="onfleet-payments-template.csv"');
  res.send(csv);
});

router.post('/bulk-import', authRequired, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  const rows = parseCsv(req.file.buffer.toString('utf8'));
  if (!rows.length) return res.status(400).json({ error: 'CSV file is empty' });

  const summary = { imported: 0, failed: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const agreement = row.agreement_id
        ? db.prepare('SELECT * FROM agreements WHERE id = ?').get(Number(row.agreement_id))
        : db.prepare('SELECT * FROM agreements WHERE agreement_no = ?').get(row.agreement_no);
      if (!agreement) throw new Error('Agreement not found');
      recordManualPayment({
        agreement_id: agreement.id,
        amount: Number(row.amount),
        method: row.method || 'eft',
        reference: row.reference || `CSV-${uuid().slice(0, 8)}`,
        paid_at: row.paid_at || new Date().toISOString(),
        notes: row.notes || 'Bulk CSV import',
        recorded_by: req.user.id
      });
      summary.imported += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  logAudit(req.user.id, 'payment.bulk_import', 'payments', null, summary);
  res.json(summary);
});

router.get('/agreement/:id', authRequired, (req, res) => {
  const ag = db.prepare('SELECT user_id FROM agreements WHERE id = ?').get(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found' });
  if (ag.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? ORDER BY created_at DESC`).all(req.params.id);
  res.json({ payments });
});

router.get('/all', authRequired, adminOnly, (req, res) => {
  const payments = db.prepare(`SELECT p.*, u.full_name, u.email, a.agreement_no
    FROM payments p JOIN users u ON u.id = p.user_id JOIN agreements a ON a.id = p.agreement_id
    ORDER BY p.created_at DESC LIMIT 500`).all();
  res.json({ payments });
});

module.exports = router;
