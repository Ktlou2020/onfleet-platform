const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses, rebuildScheduleAllocations } = require('../utils/helpersPg');
const { sendNotification } = require('../services/notifierPg');
const { applyCsvMapping, previewImportCsv } = require('../services/csvPreview');
const { parseMoney, parseDateFlexible } = require('../services/csvImports');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());
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
  return Number(payment?.net_amount) || Number(payment?.amount) || 0;
}

function adminVisibleAgreementClause(aAlias = 'a', bAlias = 'b', uAlias = 'u') {
  return `${bAlias}.organization_id IS NULL AND ${uAlias}.organization_id IS NULL`;
}

async function applyPaymentToSchedule(agreementId, amountZAR, db = pgDb) {
  const { rows: agreementRows } = await db.query('SELECT status FROM agreements WHERE id = $1', [agreementId]);
  const agreement = agreementRows[0];
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const { rows: schedule } = await db.query(`SELECT * FROM payment_schedules WHERE agreement_id = $1
    AND status != 'paid' AND status != 'waived' ORDER BY week_number ASC`, [agreementId]);
  let remaining = amountZAR;
  for (const row of schedule) {
    if (remaining <= 0) break;
    const amountDue = Number(row.amount_due);
    const amountPaid = Number(row.amount_paid);
    const owe = +(amountDue - amountPaid).toFixed(2);
    const apply = Math.min(remaining, owe);
    const newPaid = +(amountPaid + apply).toFixed(2);
    const status = newPaid >= amountDue ? 'paid' : 'partial';
    const paidAt = status === 'paid' ? new Date().toISOString() : row.paid_at;
    await db.query(`UPDATE payment_schedules SET amount_paid = $1, status = $2, paid_at = $3 WHERE id = $4`, [newPaid, status, paidAt, row.id]);
    remaining = +(remaining - apply).toFixed(2);
  }
  await recalcScheduleStatuses(agreementId, db);
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

// Postgres equivalent of csvImports.js's resolveAgreementForPayment — only
// used by this file's /bulk-import route. csvImports.js itself is still
// SQLite-based and not converted yet.
const AGREEMENT_STATUS_PRIORITY_SQL = `CASE status
  WHEN 'active' THEN 0 WHEN 'defaulted' THEN 1 WHEN 'paused' THEN 2
  WHEN 'completed' THEN 3 WHEN 'cancelled' THEN 4 WHEN 'discontinued' THEN 5 ELSE 6 END`;

async function resolveAgreementForPayment(row) {
  const registration = String(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration'] || '').trim();
  const riderName = String(row.rider_name || row.Driver || row.Rider || row['Full Name'] || '').trim();
  if (!registration) return null;

  const { rows: bikeRows } = await pgDb.query(`SELECT * FROM bikes WHERE UPPER(COALESCE(registration, '')) = UPPER($1)`, [registration]);
  const bike = bikeRows[0];
  if (!bike) return null;

  if (riderName) {
    const { rows: userRows } = await pgDb.query(
      `SELECT * FROM users WHERE LOWER(TRIM(full_name)) = LOWER(TRIM($1)) AND deleted_at IS NULL ORDER BY id DESC`,
      [riderName]
    );
    const user = userRows[0];
    if (user) {
      const { rows: exactRows } = await pgDb.query(
        `SELECT * FROM agreements WHERE bike_id = $1 AND user_id = $2 ORDER BY ${AGREEMENT_STATUS_PRIORITY_SQL}, id DESC LIMIT 1`,
        [bike.id, user.id]
      );
      if (exactRows[0]) return exactRows[0];
    }
  }

  const { rows: fallbackRows } = await pgDb.query(
    `SELECT * FROM agreements WHERE bike_id = $1 ORDER BY ${AGREEMENT_STATUS_PRIORITY_SQL}, id DESC LIMIT 1`,
    [bike.id]
  );
  return fallbackRows[0] || null;
}

async function recordManualPayment({ agreement_id, amount, method, reference, paid_at, notes, recorded_by }) {
  const { rows: agreementRows } = await pgDb.query('SELECT * FROM agreements WHERE id = $1', [agreement_id]);
  const agreement = agreementRows[0];
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const ref = reference || `MAN-${uuid().slice(0, 10)}`;
  const { rows: insertedRows } = await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES ($1,$2,$3,$4,$5,$6, 'success', $7,$8,$9,$10,$11) RETURNING id`,
    [
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
    ]);
  await applyPaymentToSchedule(agreement_id, Number(amount));
  return { id: insertedRows[0].id, reference: ref };
}

router.post('/paystack/init', authRequired, async (req, res) => {
  const { agreement_id, amount } = req.body;
  const { rows: agRows } = await pgDb.query('SELECT * FROM agreements WHERE id = $1 AND user_id = $2', [agreement_id, req.user.id]);
  const ag = agRows[0];
  if (!ag) return res.status(404).json({ error: 'Agreement not found' });
  if (ag.status === 'discontinued') return res.status(400).json({ error: 'This agreement has been discontinued because the bike was stolen' });

  // The amount arrives straight from the rider's browser and was previously
  // passed to Paystack unchecked — NaN, zero, negative, and fat-fingered
  // extra-zero amounts all relied on the gateway to reject them. Validate here
  // so bad input fails as a clear 400 rather than a 500 from Paystack.
  const netAmount = Number(amount);       // what credits the rider's agreement
  if (!Number.isFinite(netAmount) || netAmount <= 0) {
    return res.status(400).json({ error: 'Enter a valid payment amount.' });
  }

  // Nobody should be able to pay more than they still owe. Outstanding is
  // derived from successful payments (the same source of truth the agreement
  // summary uses), not from payment_schedules, which can lag.
  const { rows: paidRows } = await pgDb.query(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount, 0), amount)), 0) AS paid
       FROM payments WHERE agreement_id = $1 AND status = 'success'`, [agreement_id]);
  const outstanding = +(Number(ag.total_amount || 0) - Number(paidRows[0].paid)).toFixed(2);
  if (outstanding <= 0) {
    return res.status(400).json({ error: 'This agreement is fully paid up — no payment is due.' });
  }
  // 1c of slack so a legitimate "pay off the balance" can't be blocked by
  // floating-point drift between what the UI shows and what we recompute here.
  if (netAmount > outstanding + 0.01) {
    const shown = outstanding.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return res.status(400).json({
      error: `That is more than you owe. Your outstanding balance is R${shown}.`,
      outstanding,
    });
  }

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

    await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status, fee_amount, net_amount)
      VALUES ($1,$2,$3,$4, 'paystack', $5, $6, 'pending', $7, $8)`,
      [agreement_id, req.user.id, grossAmount, 'ZAR', reference, reference, fee, netAmount]);

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
    const { rows: paymentRows } = await pgDb.query('SELECT * FROM payments WHERE reference = $1', [req.params.reference]);
    const payment = paymentRows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    // Ensure the payment belongs to the requesting user's agreement (or admin)
    const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
    if (!isAdmin) {
      const { rows: agreementRows } = await pgDb.query('SELECT user_id FROM agreements WHERE id = $1', [payment.agreement_id]);
      const agreement = agreementRows[0];
      if (!agreement || agreement.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    if (data.status === 'success' && payment.status !== 'success') {
      const grossAmount = data.amount / 100;
      let netAmount = Number(payment.net_amount) || grossAmount; // use stored net, fallback to gross if old record

      // Credit what was actually collected, not what we intended to collect.
      // These agree for a normal Paystack charge (the amount is fixed at
      // initialize and the payer can't alter it), but crediting the stored
      // intent unconditionally means any short collection — a partial debit, a
      // gateway quirk — would silently over-credit the agreement. Scale the
      // credit down to what arrived and log the discrepancy rather than
      // quietly writing money that was never received.
      const expectedGross = calcGrossAmount(netAmount);
      if (grossAmount + 0.01 < expectedGross) {
        const collectedNet = Math.max(0, +(grossAmount - calcPaystackFee(netAmount)).toFixed(2));
        console.error('[payments] Paystack collected less than expected', {
          reference: req.params.reference, expectedGross, grossAmount,
          storedNet: netAmount, creditingNet: collectedNet,
        });
        netAmount = collectedNet;
      }

      const fee = calcPaystackFee(netAmount);
      await pgDb.query(`UPDATE payments SET status = 'success', paid_at = NOW(), amount = $1, fee_amount = $2, net_amount = $3 WHERE id = $4`, [grossAmount, fee, netAmount, payment.id]);
      await applyPaymentToSchedule(payment.agreement_id, netAmount);
      // Credit the fleet wallet if this agreement belongs to a fleet organisation.
      // The rider portal calls this endpoint immediately on Paystack redirect,
      // which normally beats the webhook's charge.success delivery — and that
      // handler only credits when payment.status !== 'success', so without this
      // the wallet credit for the standard rider-payment flow never ran.
      // creditFleetWalletFromWebhook's own reference-based idempotency means
      // it's still safe if the webhook fires for the same payment afterward.
      if (grossAmount > 0) {
        const { rows: agScopeRows } = await pgDb.query(
          `SELECT b.organization_id FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = $1`, [payment.agreement_id]
        );
        if (agScopeRows[0]?.organization_id) {
          await creditFleetWalletFromWebhook(agScopeRows[0].organization_id, grossAmount, payment.user_id, req.params.reference);
        }
      }
      await logAudit(req.user.id, 'payment.success', 'payments', payment.id, { amount: grossAmount, fee, net_amount: netAmount });
      payment.status = 'success';
      payment.net_amount = netAmount;
      payment.amount = grossAmount;
    }
    const netAmountForResponse = Number(payment.net_amount) || (data.amount / 100);
    res.json({
      status: data.status,
      amount: data.amount / 100,
      fee: calcPaystackFee(netAmountForResponse),
      net_amount: netAmountForResponse,
      credited_amount: creditedAmount(payment),
      payment
    });
  } catch (e) {
    res.status(500).json({ error: 'Verify failed', details: e.response?.data || e.message });
  }
});

router.post('/paystack/webhook', async (req, res) => {
  // Always validate Paystack HMAC signature — reject if missing or invalid
  const sig = req.headers['x-paystack-signature'];
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!sig || !secretKey) return res.sendStatus(401);
  const expected = crypto.createHmac('sha512', secretKey).update(req.body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  let sigBuf;
  try { sigBuf = Buffer.from(sig, 'hex'); } catch (_) { return res.sendStatus(401); }
  if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
    return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(req.body.toString()); } catch { return res.sendStatus(400); }

  // Distinguish fleet billing plans vs rider payment plans vs one-time
  const planCode = event.data?.plan?.plan_code || event.data?.plan;
  const hasPlan = planCode && typeof planCode === 'string' && planCode.startsWith('PLN_');
  const isRiderEvent = hasPlan && isRiderPlanCode(planCode);
  const isFleetEvent = hasPlan && !isRiderEvent && !!getKeyForPlanCode(planCode);

  // Rider subscription.create — activate the rider_subscriptions record
  if (event.event === 'subscription.create' && isRiderEvent) {
    const customerCode = event.data.customer?.customer_code;
    const subscriptionCode = event.data.subscription_code;
    const meta = event.data.metadata || {};
    const orgId = Number(meta.organization_id);
    const riderId = Number(meta.rider_user_id);
    if (orgId && riderId) {
      // Use COALESCE so an already-stored code is never overwritten by a null
      await pgDb.query(`UPDATE rider_subscriptions
        SET status = 'active',
            paystack_subscription_code = COALESCE(paystack_subscription_code, $1),
            paystack_customer_code = COALESCE(paystack_customer_code, $2),
            updated_at = NOW()
        WHERE organization_id = $3 AND rider_user_id = $4 AND status != 'cancelled'`,
        [subscriptionCode || null, customerCode || null, orgId, riderId]);
    }
  // Rider charge.success — credit the fleet wallet and record the payment
  } else if (event.event === 'charge.success' && isRiderEvent) {
    const subscriptionCode = event.data.subscription?.subscription_code;
    const customerCode = event.data.customer?.customer_code;
    const meta = event.data.metadata || {};
    const grossAmountZAR = (event.data.amount || 0) / 100;
    const reference = event.data.reference;

    let orgId = Number(meta.organization_id);
    let riderId = Number(meta.rider_user_id);
    let agreementId = Number(meta.agreement_id) || null;

    if (!orgId && subscriptionCode) {
      const { rows: subRows } = await pgDb.query(`SELECT * FROM rider_subscriptions WHERE paystack_subscription_code = $1`, [subscriptionCode]);
      const sub = subRows[0];
      if (sub) { orgId = sub.organization_id; riderId = sub.rider_user_id; agreementId = agreementId || sub.agreement_id || null; }
    }
    if (!orgId && customerCode) {
      const { rows: userRows } = await pgDb.query(`SELECT id, organization_id FROM users WHERE id IN (SELECT rider_user_id FROM rider_subscriptions WHERE paystack_customer_code = $1) LIMIT 1`,
        [customerCode]);
      const user = userRows[0];
      if (user) { orgId = user.organization_id; riderId = user.id; }
    }
    // Resolve agreement_id from rider_subscriptions — prefer the row tied to the current subscription code
    if (!agreementId && riderId && orgId) {
      const { rows: subRows } = subscriptionCode
        ? await pgDb.query(`SELECT agreement_id FROM rider_subscriptions WHERE paystack_subscription_code = $1 AND organization_id = $2 LIMIT 1`, [subscriptionCode, orgId])
        : await pgDb.query(`SELECT agreement_id FROM rider_subscriptions WHERE rider_user_id = $1 AND organization_id = $2 ORDER BY id DESC LIMIT 1`, [riderId, orgId]);
      if (subRows[0]?.agreement_id) agreementId = subRows[0].agreement_id;
    }
    // Final fallback: rider's most recent non-cancelled agreement
    // NOTE: 'overdue' is NOT a valid agreements.status — valid values are active/paused/defaulted/completed/cancelled/discontinued
    if (!agreementId && riderId) {
      const { rows: agRows } = await pgDb.query(`SELECT id FROM agreements WHERE user_id = $1 AND status IN ('active','paused','defaulted') ORDER BY id DESC LIMIT 1`, [riderId]);
      if (agRows[0]) agreementId = agRows[0].id;
    }

    if (orgId && grossAmountZAR > 0) {
      await creditFleetWalletFromWebhook(orgId, grossAmountZAR, riderId || null, reference);
      // Keep rider_subscriptions in sync: store subscription + customer codes on the row
      // so future lookups work even if Paystack metadata is absent on recurring charges.
      // COALESCE avoids overwriting already-correct values.
      if (subscriptionCode && orgId && riderId) {
        await pgDb.query(`UPDATE rider_subscriptions
          SET status = 'active',
              paystack_subscription_code = COALESCE(paystack_subscription_code, $1),
              paystack_customer_code = COALESCE(paystack_customer_code, $2),
              updated_at = NOW()
          WHERE organization_id = $3 AND rider_user_id = $4 AND status != 'cancelled'`,
          [subscriptionCode, customerCode || null, orgId, riderId]);
      } else if (subscriptionCode) {
        await pgDb.query(`UPDATE rider_subscriptions SET status = 'active', updated_at = NOW() WHERE paystack_subscription_code = $1 AND status != 'cancelled'`,
          [subscriptionCode]);
      }
      if (agreementId) {
        const fee = +(grossAmountZAR * 0.015).toFixed(2);
        const net = +(grossAmountZAR - fee).toFixed(2);
        // Wrap INSERT and schedule application in one transaction — if the process crashes
        // mid-way, the whole thing rolls back and the next webhook retry redoes both.
        await pgDb.withTransaction(async (client) => {
          const { rows: alreadyRecordedRows } = await client.query(`SELECT id FROM payments WHERE paystack_reference = $1 OR reference = $1`, [reference]);
          if (alreadyRecordedRows[0]) return;
          await client.query(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status, fee_amount, net_amount, paid_at, notes)
            VALUES ($1,$2,$3,'ZAR','paystack',$4,$5,'success',$6,$7,NOW(),'Recurring subscription payment')`,
            [agreementId, riderId || null, grossAmountZAR, reference, reference, fee, net]);
          const { rows: agRows } = await client.query('SELECT status FROM agreements WHERE id = $1', [agreementId]);
          const ag = agRows[0];
          if (ag && ag.status !== 'discontinued') {
            await applyPaymentToSchedule(agreementId, grossAmountZAR, client);
          }
        });
      } else {
        console.error(`[webhook] charge.success: could not resolve agreementId for rider ${riderId} org ${orgId} ref ${reference} — wallet credited but schedule not updated`);
      }
    }
  // Rider subscription.disable — cancel the rider subscription
  } else if (event.event === 'subscription.disable' && isRiderEvent) {
    const subscriptionCode = event.data.subscription_code;
    if (subscriptionCode) {
      await pgDb.query(`UPDATE rider_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE paystack_subscription_code = $1`,
        [subscriptionCode]);
    }
  } else if (event.event === 'subscription.create' && isFleetEvent) {
    const customerCode = event.data.customer?.customer_code;
    const subscriptionCode = event.data.subscription_code;
    const orgIdMeta = event.data.metadata?.organization_id || event.data.plan?.metadata?.organization_id;
    const key = getKeyForPlanCode(planCode);
    if (key) {
      // Prefer lookup by customer code; fall back to metadata org_id for first-time subscribers
      let org = null;
      if (customerCode) {
        const { rows } = await pgDb.query('SELECT * FROM organizations WHERE paystack_customer_code = $1', [customerCode]);
        org = rows[0];
      }
      if (!org && orgIdMeta) {
        const { rows } = await pgDb.query('SELECT * FROM organizations WHERE id = $1', [Number(orgIdMeta)]);
        org = rows[0];
      }
      if (org) {
        const plan = FLEET_BILLING_PLAN_ENTITLEMENTS[key];
        if (plan) {
          await pgDb.query(`UPDATE organizations SET plan_key = $1, status = 'active',
            paystack_subscription_code = $2,
            paystack_customer_code = COALESCE(paystack_customer_code, $3),
            max_bikes = $4, max_admin_users = $5,
            updated_at = NOW() WHERE id = $6`,
            [key, subscriptionCode, customerCode || null, plan.max_bikes, plan.max_admin_users, org.id]);
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
      let org = null;
      if (customerCode) {
        const { rows } = await pgDb.query('SELECT * FROM organizations WHERE paystack_customer_code = $1', [customerCode]);
        org = rows[0];
      }
      if (!org && orgIdMeta) {
        const { rows } = await pgDb.query('SELECT * FROM organizations WHERE id = $1', [Number(orgIdMeta)]);
        org = rows[0];
      }
      if (org) {
        const plan = FLEET_BILLING_PLAN_ENTITLEMENTS[key];
        if (plan) {
          const params = [key];
          let subClause = '';
          if (subscriptionCode) {
            params.push(subscriptionCode);
            subClause = `paystack_subscription_code = $${params.length},`;
          }
          params.push(customerCode || null, plan.max_bikes, plan.max_admin_users);
          const customerIdx = params.length - 2;
          const maxBikesIdx = params.length - 1;
          const maxAdminsIdx = params.length;
          params.push(org.id);
          const idIdx = params.length;
          await pgDb.query(`UPDATE organizations SET plan_key = $1, status = 'active',
            ${subClause}
            paystack_customer_code = COALESCE(paystack_customer_code, $${customerIdx}),
            max_bikes = $${maxBikesIdx}, max_admin_users = $${maxAdminsIdx},
            updated_at = NOW() WHERE id = $${idIdx}`, params);
        }
      }
    }
  } else if (event.event === 'subscription.disable' && !isRiderEvent) {
    const subscriptionCode = event.data.subscription_code;
    if (subscriptionCode) {
      await pgDb.query("UPDATE organizations SET status = 'cancelled', updated_at = NOW() WHERE paystack_subscription_code = $1",
        [subscriptionCode]);
    }
  } else if (event.event === 'invoice.payment_failed') {
    const subscriptionCode = event.data.subscription?.subscription_code;
    if (subscriptionCode) {
      await pgDb.query("UPDATE organizations SET status = 'past_due', updated_at = NOW() WHERE paystack_subscription_code = $1",
        [subscriptionCode]);
      const { rows: orgRows } = await pgDb.query('SELECT id FROM organizations WHERE paystack_subscription_code = $1', [subscriptionCode]);
      const org = orgRows[0];
      if (org) {
        const { rows: orgAdmins } = await pgDb.query(
          `SELECT id, full_name FROM users WHERE organization_id = $1 AND role IN ('fleet_owner_admin','fleet_owner_ops') AND status = 'active' AND deleted_at IS NULL`,
          [org.id]
        );
        for (const admin of orgAdmins) {
          sendNotification({
            userId: admin.id,
            channel: 'email',
            type: 'billing_payment_failed',
            title: 'OnFleet subscription payment failed',
            message: `Hi ${admin.full_name.split(' ')[0]}, your OnFleet fleet subscription payment failed and your account has been suspended. Log in to update your payment method and restore access to your fleet.`
          }).catch((e) => console.error(`[webhook] billing_payment_failed notify failed for org ${org.id}:`, e.message));
        }
      }
    }
  } else if (event.event === 'charge.success' && !isFleetEvent) {
    // One-time Paystack charge (no subscription plan, or unrecognised plan code)
    const ref = event.data.reference;
    const grossAmountZAR = (event.data.amount || 0) / 100;
    const meta = event.data.metadata || {};
    const metaOrgId = Number(meta.organization_id) || null;
    const metaRiderId = Number(meta.rider_user_id) || null;
    const metaAgreementId = Number(meta.agreement_id) || null;

    // Look up pre-existing payment record (used by the admin/rider portal path)
    const { rows: paymentRows } = await pgDb.query('SELECT * FROM payments WHERE reference = $1 OR paystack_reference = $1', [ref]);
    const payment = paymentRows[0];

    if (payment && payment.status !== 'success') {
      const netAmount = Number(payment.net_amount) || grossAmountZAR;
      const fee = calcPaystackFee(netAmount);
      await pgDb.query(`UPDATE payments SET status = 'success', paid_at = NOW(), amount = $1, fee_amount = $2, net_amount = $3 WHERE id = $4`,
        [grossAmountZAR, fee, netAmount, payment.id]);
      await applyPaymentToSchedule(payment.agreement_id, netAmount);
      // Credit the fleet wallet if this agreement belongs to a fleet organisation
      if (grossAmountZAR > 0) {
        const { rows: agScopeRows } = await pgDb.query(
          `SELECT b.organization_id FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = $1`, [payment.agreement_id]
        );
        if (agScopeRows[0]?.organization_id) {
          await creditFleetWalletFromWebhook(agScopeRows[0].organization_id, grossAmountZAR, payment.user_id, ref);
        }
      }
    } else if (!payment && metaAgreementId && metaOrgId && grossAmountZAR > 0) {
      // Fleet one-time payment link — no pre-inserted record; build from webhook metadata
      const { rows: agreementRows } = await pgDb.query('SELECT * FROM agreements WHERE id = $1', [metaAgreementId]);
      const agreement = agreementRows[0];
      if (agreement && agreement.status !== 'discontinued') {
        const { rows: alreadyRecordedRows } = await pgDb.query('SELECT id FROM payments WHERE paystack_reference = $1', [ref]);
        if (!alreadyRecordedRows[0]) {
          const fee = +(grossAmountZAR * 0.015).toFixed(2);
          const net = +(grossAmountZAR - fee).toFixed(2);
          await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status, fee_amount, net_amount, paid_at, notes)
            VALUES ($1,$2,$3,'ZAR','paystack',$4,$5,'success',$6,$7,NOW(),'Paystack payment')`,
            [metaAgreementId, metaRiderId || agreement.user_id, grossAmountZAR, ref, ref, fee, net]);
          try { await applyPaymentToSchedule(metaAgreementId, grossAmountZAR); } catch (_) {}
          await creditFleetWalletFromWebhook(metaOrgId, grossAmountZAR, metaRiderId || agreement.user_id, ref);
        }
      }
    }
  }

  res.sendStatus(200);
});

// Shared plan lookup used by webhook — must stay in sync with FLEET_BILLING_PLANS in fleet.js
const FLEET_BILLING_PLAN_ENTITLEMENTS = {
  small:  { max_bikes: 6,    max_admin_users: 2  },
  medium: { max_bikes: 20,   max_admin_users: 3  },
  large:  { max_bikes: 35,   max_admin_users: 5  },
  empire: { max_bikes: 9999, max_admin_users: 20 },
};

function getKeyForPlanCode(planCode) {
  for (const key of Object.keys(FLEET_BILLING_PLAN_ENTITLEMENTS)) {
    const envCode = process.env[`PAYSTACK_PLAN_${key.toUpperCase()}`];
    if (envCode && envCode === planCode) return key;
  }
  return null;
}

const RIDER_PLAN_AMOUNTS = [500, 650, 700, 750, 800, 850, 1000, 1200];

function isRiderPlanCode(planCode) {
  return RIDER_PLAN_AMOUNTS.some((amt) => {
    const riderCode = process.env[`PAYSTACK_RIDER_PLAN_${amt}`];
    const fleetCode = process.env[`PAYSTACK_FlEET_PLAN_${amt}`];
    return (riderCode && riderCode === planCode) || (fleetCode && fleetCode === planCode);
  });
}

async function ensureFleetWallet(organizationId, db = pgDb) {
  await db.query(`INSERT INTO fleet_wallets (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`, [organizationId]);
}

async function creditFleetWalletFromWebhook(organizationId, grossAmountZAR, riderId, reference) {
  const fee = +(grossAmountZAR * 0.035 + 1).toFixed(2);
  const net = +(grossAmountZAR - fee).toFixed(2);
  await ensureFleetWallet(organizationId);
  await pgDb.withTransaction(async (client) => {
    // ON CONFLICT against idx_fleet_wallet_txns_credit_reference makes this
    // safe against the verify endpoint and the webhook both trying to credit
    // the same payment (whichever runs first wins, the other is a no-op),
    // and against Paystack retrying webhook delivery for the same event.
    const { rows: insertedRows } = await client.query(
      `INSERT INTO fleet_wallet_transactions (organization_id, type, amount, fee_amount, net_amount, description, paystack_reference, rider_user_id, available_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '48 hours')
       ON CONFLICT (paystack_reference) WHERE type = 'credit' AND paystack_reference IS NOT NULL DO NOTHING
       RETURNING id`,
      [organizationId, 'credit', grossAmountZAR, fee, net, 'Weekly rider rental payment', reference || null, riderId || null]
    );
    if (!insertedRows[0]) return; // already credited for this reference
    await client.query(`UPDATE fleet_wallets SET balance = balance + $1, total_collected = total_collected + $2, updated_at = NOW() WHERE organization_id = $3`,
      [net, net, organizationId]);
  });
}

// Unwinds a fleet wallet credit previously produced by creditFleetWalletFromWebhook,
// for the given payment reference. No-op if that payment never credited a fleet
// wallet (e.g. non-fleet bike, or payment never reached success). Records an
// 'adjustment' row rather than deleting the original credit, so the ledger keeps
// a full history of what happened and why.
async function reverseFleetWalletCredit(reference, reason) {
  if (!reference) return;
  await pgDb.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM fleet_wallet_transactions WHERE paystack_reference = $1 AND type = 'credit'`, [reference]
    );
    const credit = rows[0];
    if (!credit) return;
    await client.query(
      `UPDATE fleet_wallets SET balance = balance - $1, total_collected = total_collected - $2, updated_at = NOW() WHERE organization_id = $3`,
      [credit.net_amount, credit.net_amount, credit.organization_id]
    );
    await client.query(
      `INSERT INTO fleet_wallet_transactions (organization_id, type, amount, fee_amount, net_amount, description, paystack_reference, rider_user_id, available_at)
       VALUES ($1,'adjustment',$2,0,$3,$4,$5,$6, NOW())`,
      [credit.organization_id, -credit.amount, -credit.net_amount, reason || `Reversal of payment ${reference}`, reference, credit.rider_user_id]
    );
  });
}

router.post('/manual', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows: visibleAgreementRows } = await pgDb.query(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.body.agreement_id]);
    if (!visibleAgreementRows[0]) return res.status(404).json({ error: 'Agreement not found' });
    const result = await recordManualPayment({ ...req.body, recorded_by: req.user.id });
    await logAudit(req.user.id, 'payment.manual', 'payments', result.id, { amount: req.body.amount, method: req.body.method });
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

router.post('/bulk-import', authRequired, adminOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required' });
  const mappedBuffer = req.body?.mappings ? applyCsvMapping(req.file.buffer, 'payments_bulk', JSON.parse(req.body.mappings)) : req.file.buffer;
  const rows = parseCsv(mappedBuffer.toString('utf8'));
  if (!rows.length) return res.status(400).json({ error: 'CSV file is empty' });

  const summary = { imported: 0, skipped: 0, failed: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const registration = String(row.registration || '').trim();
      if (!registration) throw new Error('Bike registration is required');
      const agreement = await resolveAgreementForPayment(row);
      if (!agreement) throw new Error(`Agreement not found for registration ${registration}`);
      const amount = parseMoney(row.amount);
      if (!amount || amount <= 0) throw new Error(`Invalid or missing amount "${row.amount}"`);
      const paidAt = parseDateFlexible(row.paid_at) || new Date().toISOString().slice(0, 10);
      const reference = buildBulkPaymentReference({ ...row, paid_at: paidAt });
      const { rows: existsRows } = await pgDb.query('SELECT id FROM payments WHERE reference = $1', [reference]);
      if (existsRows[0]) {
        summary.skipped += 1;
        continue;
      }
      await recordManualPayment({
        agreement_id: agreement.id,
        amount,
        method: row.method || 'eft',
        reference,
        paid_at: paidAt,
        notes: row.notes || `Bulk CSV import for registration ${registration}`,
        recorded_by: req.user.id
      });
      summary.imported += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  await logAudit(req.user.id, 'payment.bulk_import', 'payments', null, { ...summary, mappings: req.body?.mappings ? JSON.parse(req.body.mappings) : null });
  res.json(summary);
});

router.get('/agreement/:id', authRequired, async (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const { rows: agRows } = await pgDb.query(`SELECT a.user_id
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = $1${isAdminPortalUser ? ` AND ${adminVisibleAgreementClause('a', 'b', 'u')}` : ''}`, [req.params.id]);
  const ag = agRows[0];
  if (!ag) return res.status(404).json({ error: 'Not found' });
  if (ag.user_id !== req.user.id && !isAdminPortalUser) return res.status(403).json({ error: 'Forbidden' });
  const { rows: payments } = await pgDb.query(`SELECT * FROM payments WHERE agreement_id = $1 ORDER BY created_at DESC`, [req.params.id]);
  res.json({ payments });
});

router.get('/all', authRequired, adminOnly, async (req, res) => {
  const { rows: payments } = await pgDb.query(`SELECT p.*, u.full_name, u.email, a.agreement_no
    FROM payments p
    JOIN users u ON u.id = p.user_id
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    WHERE ${adminVisibleAgreementClause('a', 'b', 'u')}
    ORDER BY p.created_at DESC LIMIT 500`);
  res.json({ payments });
});

router.post('/bulk-delete', authRequired, adminOnly, async (req, res) => {
  const paymentIds = Array.from(new Set((Array.isArray(req.body.payment_ids) ? req.body.payment_ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)));

  if (!paymentIds.length) return res.status(400).json({ error: 'Select at least one payment to delete' });

  const deleted = [];
  const notFound = [];
  const agreementIds = new Set();

  for (const paymentId of paymentIds) {
    const { rows: paymentRows } = await pgDb.query('SELECT id, agreement_id, reference, amount, net_amount, status FROM payments WHERE id = $1', [paymentId]);
    const payment = paymentRows[0];
    if (!payment) {
      notFound.push(paymentId);
      continue;
    }
    await pgDb.query('DELETE FROM payments WHERE id = $1', [payment.id]);
    agreementIds.add(payment.agreement_id);
    deleted.push(payment);
  }

  for (const agreementId of agreementIds) await rebuildScheduleAllocations(agreementId);
  for (const payment of deleted) await reverseFleetWalletCredit(payment.reference, `Payment ${payment.reference} deleted`);

  await logAudit(req.user.id, 'payment.bulk_delete', 'payments', null, {
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

router.post('/:id/reverse', authRequired, adminOnly, async (req, res) => {
  const { rows: paymentRows } = await pgDb.query(`SELECT p.* FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE p.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
  const payment = paymentRows[0];
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  if (payment.status === 'reversed') return res.status(400).json({ error: 'Payment is already reversed' });
  await pgDb.query(`UPDATE payments SET status = 'reversed' WHERE id = $1`, [payment.id]);
  await rebuildScheduleAllocations(payment.agreement_id);
  await reverseFleetWalletCredit(payment.reference, `Reversal of payment ${payment.reference}`);
  await logAudit(req.user.id, 'payment.reversed', 'payments', payment.id, { original_status: payment.status, amount: payment.amount }, req.ip);
  res.json({ ok: true });
});

module.exports = router;
