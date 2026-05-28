const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');
const { applyCsvMapping, previewImportCsv } = require('../services/csvPreview');
const { resolveAgreementForPayment } = require('../services/csvImports');

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
function creditedAmount(payment) {
  return Number(payment?.net_amount || payment?.amount || 0);
}

function adminVisibleAgreementClause(aAlias = 'a', bAlias = 'b', uAlias = 'u') {
  return `${bAlias}.organization_id IS NULL AND ${uAlias}.organization_id IS NULL`;
}

function applyPaymentToSchedule(agreementId, amountZAR) {
  const agreement = db.prepare('SELECT status FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued because the bike was stolen');
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

function sanitizeReferencePart(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function buildBulkPaymentReference(row, fallbackPrefix = 'CSV') {
  const baseReference = sanitizeReferencePart(row.reference) || `${fallbackPrefix}-${uuid().slice(0, 8)}`;
  const registration = sanitizeReferencePart(row.registration);
  const paidAtToken = sanitizeReferencePart(String(row.paid_at || '').slice(0, 10).replace(/[^0-9]/g, ''));
  return [baseReference, registration, paidAtToken].filter(Boolean).join('-');
}

function recordManualPayment({ agreement_id, amount, method, reference, paid_at, notes, recorded_by }) {
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement_id);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued because the bike was stolen');
  const ref = reference || `MAN-${uuid().slice(0, 10)}`;
  const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES (?,?,?,?, ?, ?, 'success', ?, ?, ?, ?, ?)`).run(
      agreement_id,
      agreement.user_id,
      Number(amount),
      'ZAR',
      method || 'eft',
      ref,
      paid_at || new Date().toISOString(),
      recorded_by || null,
      notes || null,
      0,
      Number(amount)
    );
  applyPaymentToSchedule(agreement_id, Number(amount));
  return { id: info.lastInsertRowid, reference: ref };
}

function rebuildScheduleAllocations(agreementId) {
  const today = new Date().toISOString().slice(0, 10);
  const schedules = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number ASC`).all(agreementId);
  if (!schedules.length) return;

  const reset = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);
  for (const schedule of schedules) {
    if (schedule.status === 'waived') {
      reset.run(0, null, 'waived', schedule.id);
    } else {
      reset.run(0, null, schedule.due_date < today ? 'overdue' : 'pending', schedule.id);
    }
  }

  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? AND status = 'success' ORDER BY COALESCE(paid_at, created_at) ASC, id ASC`).all(agreementId);
  const applicable = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  const updateApplied = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);

  for (const payment of payments) {
    let remaining = creditedAmount(payment);
    for (const schedule of applicable) {
      if (remaining <= 0) break;
      const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
      if (owed <= 0) continue;
      const applied = Math.min(remaining, owed);
      schedule.amount_paid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
      schedule.paid_at = schedule.paid_at || payment.paid_at || payment.created_at || null;
      schedule.status = schedule.amount_paid >= Number(schedule.amount_due) ? 'paid' : 'partial';
      updateApplied.run(schedule.amount_paid, schedule.paid_at, schedule.status, schedule.id);
      remaining = +(remaining - applied).toFixed(2);
    }
  }

  for (const schedule of applicable) {
    let status = schedule.status;
    if (Number(schedule.amount_paid || 0) >= Number(schedule.amount_due || 0)) status = 'paid';
    else if (Number(schedule.amount_paid || 0) > 0 && schedule.due_date < today) status = 'overdue';
    else if (Number(schedule.amount_paid || 0) > 0) status = 'partial';
    else if (schedule.due_date < today) status = 'overdue';
    else status = 'pending';
    updateApplied.run(schedule.amount_paid || 0, schedule.paid_at || null, status, schedule.id);
  }
}

router.post('/paystack/init', authRequired, async (req, res) => {
  const { agreement_id, amount } = req.body;
  const ag = db.prepare('SELECT * FROM agreements WHERE id = ? AND user_id = ?').get(agreement_id, req.user.id);
  if (!ag) return res.status(404).json({ error: 'Agreement not found' });
  if (ag.status === 'discontinued') return res.status(400).json({ error: 'This agreement has been discontinued because the bike was stolen' });

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

    res.json({
      authorization_url: resp.data.data.authorization_url,
      reference,
      access_code: resp.data.data.access_code,
      amount: grossAmount,
      fee,
      net_amount: netAmount,
      base_amount: netAmount
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
    res.json({
      status: data.status,
      amount: data.amount / 100,
      fee: calcPaystackFee(payment.net_amount || data.amount / 100),
      net_amount: payment.net_amount || data.amount / 100,
      credited_amount: creditedAmount(payment),
      payment
    });
  } catch (e) {
    res.status(500).json({ error: 'Verify failed', details: e.response?.data || e.message });
  }
});

router.post('/paystack/webhook', (req, res) => {
  // Validate Paystack HMAC signature when present
  const sig = req.headers['x-paystack-signature'];
  if (sig && process.env.PAYSTACK_SECRET_KEY) {
    const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest('hex');
    if (expected !== sig) return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(req.body.toString()); } catch { return res.sendStatus(400); }

  // Fleet subscription events — identified by the presence of a plan code
  const planCode = event.data?.plan?.plan_code || event.data?.plan;
  const isFleetEvent = planCode && typeof planCode === 'string' && planCode.startsWith('PLN_');

  if (event.event === 'subscription.create' && isFleetEvent) {
    const customerCode = event.data.customer?.customer_code;
    const subscriptionCode = event.data.subscription_code;
    const orgIdMeta = event.data.metadata?.organization_id || event.data.plan?.metadata?.organization_id;
    const key = getKeyForPlanCode(planCode);
    if (key) {
      // Prefer lookup by customer code; fall back to metadata org_id for first-time subscribers
      const org = (customerCode && db.prepare('SELECT * FROM organizations WHERE paystack_customer_code = ?').get(customerCode))
        || (orgIdMeta && db.prepare('SELECT * FROM organizations WHERE id = ?').get(Number(orgIdMeta)));
      if (org) {
        const plan = FLEET_BILLING_PLAN_ENTITLEMENTS[key];
        if (plan) {
          db.prepare(`UPDATE organizations SET plan_key = ?, status = 'active',
            paystack_subscription_code = ?,
            paystack_customer_code = COALESCE(paystack_customer_code, ?),
            max_bikes = ?, max_admin_users = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(key, subscriptionCode, customerCode || null, plan.max_bikes, plan.max_admin_users, org.id);
        }
      }
    }
  } else if (event.event === 'charge.success' && isFleetEvent) {
    // Recurring subscription charge — keep org active and update subscription code if needed
    const customerCode = event.data.customer?.customer_code;
    const subscriptionCode = event.data.subscription?.subscription_code;
    const orgIdMeta = event.data.metadata?.organization_id;
    const key = getKeyForPlanCode(planCode);
    if (key) {
      const org = (customerCode && db.prepare('SELECT * FROM organizations WHERE paystack_customer_code = ?').get(customerCode))
        || (orgIdMeta && db.prepare('SELECT * FROM organizations WHERE id = ?').get(Number(orgIdMeta)));
      if (org) {
        const plan = FLEET_BILLING_PLAN_ENTITLEMENTS[key];
        if (plan) {
          db.prepare(`UPDATE organizations SET plan_key = ?, status = 'active',
            ${subscriptionCode ? 'paystack_subscription_code = ?,' : ''}
            paystack_customer_code = COALESCE(paystack_customer_code, ?),
            max_bikes = ?, max_admin_users = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(key, ...(subscriptionCode ? [subscriptionCode] : []), customerCode || null, plan.max_bikes, plan.max_admin_users, org.id);
        }
      }
    }
  } else if (event.event === 'subscription.disable') {
    const subscriptionCode = event.data.subscription_code;
    if (subscriptionCode) {
      db.prepare("UPDATE organizations SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE paystack_subscription_code = ?")
        .run(subscriptionCode);
    }
  } else if (event.event === 'invoice.payment_failed') {
    const subscriptionCode = event.data.subscription?.subscription_code;
    if (subscriptionCode) {
      db.prepare("UPDATE organizations SET status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE paystack_subscription_code = ?")
        .run(subscriptionCode);
    }
  } else if (event.event === 'charge.success' && !isFleetEvent) {
    // Rider one-time payment
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

// Shared plan lookup used by webhook (mirrors fleet.js FLEET_BILLING_PLANS)
const FLEET_BILLING_PLAN_ENTITLEMENTS = {
  small:  { max_bikes: 20, max_admin_users: 3 },
  medium: { max_bikes: 60, max_admin_users: 5 },
  large:  { max_bikes: 100, max_admin_users: 10 }
};

function getKeyForPlanCode(planCode) {
  for (const key of Object.keys(FLEET_BILLING_PLAN_ENTITLEMENTS)) {
    const envCode = process.env[`PAYSTACK_PLAN_${key.toUpperCase()}`];
    if (envCode && envCode === planCode) return key;
  }
  return null;
}

router.post('/manual', authRequired, adminOnly, (req, res) => {
  try {
    const visibleAgreement = db.prepare(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.body.agreement_id);
    if (!visibleAgreement) return res.status(404).json({ error: 'Agreement not found' });
    const result = recordManualPayment({ ...req.body, recorded_by: req.user.id });
    logAudit(req.user.id, 'payment.manual', 'payments', result.id, { amount: req.body.amount, method: req.body.method });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/bulk-preview', authRequired, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  try {
    res.json(previewImportCsv(req.file.buffer, 'payments_bulk'));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/bulk-template', authRequired, adminOnly, (req, res) => {
  const csv = [
    'registration,amount,method,reference,paid_at,rider_name,notes',
    'JHB 452 GP,850,eft,BANKREF001,2026-05-06T08:00:00Z,Sipho Dlamini,Imported bank statement batch'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="onfleet-payments-template.csv"');
  res.send(csv);
});

router.post('/bulk-import', authRequired, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  const mappedBuffer = req.body?.mappings ? applyCsvMapping(req.file.buffer, 'payments_bulk', JSON.parse(req.body.mappings)) : req.file.buffer;
  const rows = parseCsv(mappedBuffer.toString('utf8'));
  if (!rows.length) return res.status(400).json({ error: 'CSV file is empty' });

  const summary = { imported: 0, skipped: 0, failed: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const registration = String(row.registration || '').trim();
      if (!registration) throw new Error('Bike registration is required');
      const agreement = resolveAgreementForPayment(row);
      if (!agreement) throw new Error(`Agreement not found for registration ${registration}`);
      const reference = buildBulkPaymentReference(row);
      const exists = db.prepare('SELECT id FROM payments WHERE reference = ?').get(reference);
      if (exists) {
        summary.skipped += 1;
        continue;
      }
      recordManualPayment({
        agreement_id: agreement.id,
        amount: Number(row.amount),
        method: row.method || 'eft',
        reference,
        paid_at: row.paid_at || new Date().toISOString(),
        notes: row.notes || `Bulk CSV import for registration ${registration}`,
        recorded_by: req.user.id
      });
      summary.imported += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  logAudit(req.user.id, 'payment.bulk_import', 'payments', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null });
  res.json(summary);
});

router.get('/agreement/:id', authRequired, (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const ag = db.prepare(`SELECT a.user_id
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?${isAdminPortalUser ? ` AND ${adminVisibleAgreementClause('a', 'b', 'u')}` : ''}`).get(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found' });
  if (ag.user_id !== req.user.id && !isAdminPortalUser) return res.status(403).json({ error: 'Forbidden' });
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? ORDER BY created_at DESC`).all(req.params.id);
  res.json({ payments });
});

router.get('/all', authRequired, adminOnly, (req, res) => {
  const payments = db.prepare(`SELECT p.*, u.full_name, u.email, a.agreement_no
    FROM payments p
    JOIN users u ON u.id = p.user_id
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    WHERE ${adminVisibleAgreementClause('a', 'b', 'u')}
    ORDER BY p.created_at DESC LIMIT 500`).all();
  res.json({ payments });
});

router.post('/bulk-delete', authRequired, adminOnly, (req, res) => {
  const paymentIds = Array.from(new Set((Array.isArray(req.body.payment_ids) ? req.body.payment_ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)));

  if (!paymentIds.length) return res.status(400).json({ error: 'Select at least one payment to delete' });

  const deleted = [];
  const notFound = [];
  const agreementIds = new Set();
  const removePayment = db.prepare('DELETE FROM payments WHERE id = ?');

  for (const paymentId of paymentIds) {
    const payment = db.prepare('SELECT id, agreement_id, reference, amount, net_amount, status FROM payments WHERE id = ?').get(paymentId);
    if (!payment) {
      notFound.push(paymentId);
      continue;
    }
    removePayment.run(payment.id);
    agreementIds.add(payment.agreement_id);
    deleted.push(payment);
  }

  for (const agreementId of agreementIds) rebuildScheduleAllocations(agreementId);

  logAudit(req.user.id, 'payment.bulk_delete', 'payments', null, {
    requested: paymentIds.length,
    deleted_count: deleted.length,
    not_found_count: notFound.length,
    payment_ids: deleted.map((payment) => payment.id),
    references: deleted.map((payment) => payment.reference)
  }, req.ip);

  res.json({
    ok: true,
    requested: paymentIds.length,
    deleted_count: deleted.length,
    not_found_count: notFound.length,
    deleted: deleted.map((payment) => ({
      id: payment.id,
      agreement_id: payment.agreement_id,
      reference: payment.reference,
      amount: payment.amount,
      net_amount: payment.net_amount,
      status: payment.status
    })),
    not_found: notFound
  });
});

module.exports = router;
