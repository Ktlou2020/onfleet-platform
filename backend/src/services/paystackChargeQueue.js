'use strict';

// Paystack charges the platform can't credit on its own, held for a person to
// confirm, plus the tools for finding riders with more than one live
// subscription. migrations/1787900000000_paystack-charge-review-queue.cjs
// explains how riders' debit orders came to be dropped in the first place.
//
// Nothing here credits a rider automatically. Staff have typed debit orders in
// by hand for months without the Paystack reference, so an automatic credit
// would land on top of a manual one. Confirming is the only way a queued charge
// becomes a payment, and it records the reference so the same charge can't be
// credited twice.

const axios = require('axios');
const pgDb = require('../pgDb');
const { logAudit, rebuildScheduleAllocations } = require('../utils/helpersPg');
const { calcGrossAmount } = require('../utils/paystackFees');

const PAYSTACK_BASE = 'https://api.paystack.co';
// 'attention' means a charge failed and Paystack is retrying it: it will take
// money the moment the card has funds. 'non-renewing' will not charge again.
const CHARGEABLE = ['active', 'attention'];

const paystackHeaders = () => ({ Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` });
const money = (v) => +Number(v || 0).toFixed(2);

class QueueError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Webhook events and the transaction-list API describe a charge the same way,
// except plan, which arrives as an object in one and a bare code in the other.
function planCodeOf(tx) {
  if (!tx.plan) return null;
  return typeof tx.plan === 'object' ? tx.plan.plan_code || null : String(tx.plan);
}

// Enough to reconcile a charge later. The card's authorization block is left
// out on purpose: its authorization_code can be used to charge the card again.
function trimmedRaw(tx) {
  return {
    id: tx.id, reference: tx.reference, amount: tx.amount, currency: tx.currency, channel: tx.channel,
    gateway_response: tx.gateway_response, paid_at: tx.paid_at || tx.paidAt,
    plan: tx.plan && typeof tx.plan === 'object' ? { plan_code: tx.plan.plan_code, name: tx.plan.name } : tx.plan || null,
    subscription: tx.subscription?.subscription_code ? { subscription_code: tx.subscription.subscription_code } : null,
    customer: { email: tx.customer?.email || null, customer_code: tx.customer?.customer_code || null },
    metadata: tx.metadata || null,
  };
}

async function resolveRiderAndAgreement(tx) {
  const meta = tx.metadata || {};
  let riderId = Number(meta.rider_user_id) || null;
  if (!riderId && tx.customer?.email) {
    const { rows } = await pgDb.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL ORDER BY id LIMIT 1`, [tx.customer.email]);
    riderId = rows[0]?.id || null;
  }
  let agreementId = Number(meta.agreement_id) || null;
  if (agreementId && riderId) {
    // Metadata is only as good as the link it came from.
    const { rows } = await pgDb.query('SELECT id FROM agreements WHERE id = $1 AND user_id = $2', [agreementId, riderId]);
    if (!rows[0]) agreementId = null;
  }
  if (!agreementId && riderId) {
    const { rows } = await pgDb.query(
      `SELECT id FROM agreements WHERE user_id = $1 AND status IN ('active','paused','defaulted')
        ORDER BY (status = 'active') DESC, id DESC LIMIT 1`, [riderId]);
    agreementId = rows[0]?.id || null;
  }
  return { riderId, agreementId };
}

// Queues one successful Paystack charge. Idempotent on the reference, and a
// charge that is already a payment is never queued. Returns the new row, or
// null when there was nothing to add.
async function queueCharge(tx, { source = 'webhook' } = {}) {
  const reference = tx?.reference;
  if (!reference) return null;
  const { rows: existing } = await pgDb.query(
    'SELECT 1 FROM payments WHERE paystack_reference = $1 OR reference = $1 LIMIT 1', [reference]);
  if (existing[0]) return null;

  const { riderId, agreementId } = await resolveRiderAndAgreement(tx);
  const { rows } = await pgDb.query(`
    INSERT INTO paystack_charges
      (reference, paystack_transaction_id, customer_email, customer_code, subscription_code, plan_code,
       amount, channel, paid_at, rider_user_id, agreement_id, source, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (reference) DO NOTHING
    RETURNING *`,
    [reference, tx.id || null, tx.customer?.email || null, tx.customer?.customer_code || null,
      tx.subscription?.subscription_code || null, planCodeOf(tx), money((tx.amount || 0) / 100), tx.channel || null,
      tx.paid_at || tx.paidAt || new Date().toISOString(), riderId, agreementId, source, JSON.stringify(trimmedRaw(tx))]);
  return rows[0] || null;
}

// What a charge should count toward the agreement. Rider plans build the card
// fee in, so R800 of rental arrives as a charge of about R824, and schedules
// are kept in rental. When a charge is the weekly rental plus fee, suggest the
// rental; otherwise suggest the charge and leave it to the person confirming.
function suggestedCredit(amount, weeklyAmount) {
  const weekly = Number(weeklyAmount);
  if (weekly > 0 && Math.abs(calcGrossAmount(weekly) - Number(amount)) <= 1) return money(weekly);
  return money(amount);
}

async function listCharges({ status = 'unconfirmed', limit = 300 } = {}) {
  const { rows } = await pgDb.query(`
    SELECT c.id, c.reference, c.amount, c.channel, c.paid_at, c.source, c.status, c.subscription_code, c.customer_email,
           c.rider_user_id, c.agreement_id, c.payment_id, c.resolution_note, c.resolved_at,
           u.full_name AS rider_name, a.agreement_no, a.status AS agreement_status, a.weekly_amount,
           rb.full_name AS resolved_by_name,
           pm.id AS possible_payment_id, pm.amount AS possible_payment_amount, pm.reference AS possible_payment_reference,
           pm.method AS possible_payment_method, COALESCE(pm.paid_at, pm.created_at) AS possible_payment_at
      FROM paystack_charges c
      LEFT JOIN users u ON u.id = c.rider_user_id
      LEFT JOIN agreements a ON a.id = c.agreement_id
      LEFT JOIN users rb ON rb.id = c.resolved_by
      -- The payment someone may already have typed in for this charge. A hint,
      -- not a verdict: a rider who pays weekly will usually have one nearby.
      LEFT JOIN LATERAL (
        SELECT p.* FROM payments p JOIN agreements pa ON pa.id = p.agreement_id
         WHERE c.status = 'unconfirmed' AND pa.user_id = c.rider_user_id AND p.status = 'success'
           AND (ABS(p.amount - c.amount) <= 30 OR ABS(COALESCE(p.net_amount, 0) - c.amount) <= 30)
           AND COALESCE(p.paid_at, p.created_at) BETWEEN c.paid_at - INTERVAL '14 days' AND c.paid_at + INTERVAL '14 days'
         ORDER BY ABS(EXTRACT(EPOCH FROM (COALESCE(p.paid_at, p.created_at) - c.paid_at)))
         LIMIT 1) pm ON TRUE
     WHERE c.status = $1
     ORDER BY c.paid_at DESC
     LIMIT $2`, [status, limit]);

  return rows.map((r) => ({
    id: r.id, reference: r.reference, amount: money(r.amount), channel: r.channel, paid_at: r.paid_at,
    source: r.source, status: r.status, subscription_code: r.subscription_code, customer_email: r.customer_email,
    rider_user_id: r.rider_user_id, rider_name: r.rider_name,
    agreement_id: r.agreement_id, agreement_no: r.agreement_no, agreement_status: r.agreement_status,
    suggested_credit: suggestedCredit(r.amount, r.weekly_amount),
    payment_id: r.payment_id, resolution_note: r.resolution_note, resolved_at: r.resolved_at, resolved_by_name: r.resolved_by_name,
    possible_existing_payment: r.possible_payment_id ? {
      id: r.possible_payment_id, amount: money(r.possible_payment_amount), reference: r.possible_payment_reference,
      method: r.possible_payment_method, paid_at: r.possible_payment_at,
    } : null,
  }));
}

async function confirmCharge(id, { agreementId, creditedAmount, userId, ip = null }) {
  const credit = money(creditedAmount);
  if (!(credit > 0)) throw new QueueError('Enter the amount to credit to the agreement');

  const result = await pgDb.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM paystack_charges WHERE id = $1 FOR UPDATE', [id]);
    const charge = rows[0];
    if (!charge) throw new QueueError('Charge not found', 404);
    if (charge.status !== 'unconfirmed') throw new QueueError(`This charge has already been ${charge.status}`, 409);
    if (credit > Number(charge.amount) + 0.01) {
      throw new QueueError(`Can't credit more than the R${Number(charge.amount).toFixed(2)} that was charged`);
    }

    const targetAgreementId = Number(agreementId) || charge.agreement_id;
    if (!targetAgreementId) throw new QueueError('Choose the agreement this charge pays for');
    const { rows: agRows } = await client.query('SELECT id, user_id, status FROM agreements WHERE id = $1', [targetAgreementId]);
    const agreement = agRows[0];
    if (!agreement) throw new QueueError('Agreement not found', 404);
    if (charge.rider_user_id && agreement.user_id !== charge.rider_user_id) {
      throw new QueueError("That agreement doesn't belong to the rider who was charged");
    }

    // The reference is what stops the same money being credited twice.
    const { rows: dup } = await client.query(
      'SELECT id FROM payments WHERE paystack_reference = $1 OR reference = $1 LIMIT 1', [charge.reference]);
    if (dup[0]) throw new QueueError('A payment with this Paystack reference is already recorded', 409);

    const { rows: paymentRows } = await client.query(`
      INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, paystack_reference, status,
                            fee_amount, net_amount, paid_at, recorded_by, notes)
      VALUES ($1,$2,$3,'ZAR','paystack',$4,$4,'success',$5,$6,$7,$8,'Paystack debit order confirmed from the review queue')
      RETURNING id`,
      [agreement.id, agreement.user_id, money(charge.amount), charge.reference,
        money(Number(charge.amount) - credit), credit, charge.paid_at, userId || null]);
    const paymentId = paymentRows[0].id;

    // Re-cascade every payment over the schedule rather than applying this one
    // on top, so the schedule comes out the same however payments arrived.
    if (agreement.status !== 'discontinued') await rebuildScheduleAllocations(agreement.id, client);

    await client.query(
      `UPDATE paystack_charges SET status = 'confirmed', agreement_id = $1, payment_id = $2, resolved_by = $3, resolved_at = NOW()
        WHERE id = $4`, [agreement.id, paymentId, userId || null, id]);
    return { payment_id: paymentId, agreement_id: agreement.id, reference: charge.reference, amount: money(charge.amount) };
  });

  await logAudit(userId, 'paystack_charge.confirmed', 'paystack_charges', Number(id), { ...result, credited: credit }, ip);
  return { ...result, credited: credit };
}

async function dismissCharge(id, { note, userId, ip = null }) {
  const reason = String(note || '').trim();
  if (!reason) throw new QueueError('Say why this charge is being dismissed');
  const { rows } = await pgDb.query(`
    UPDATE paystack_charges SET status = 'dismissed', resolution_note = $1, resolved_by = $2, resolved_at = NOW()
     WHERE id = $3 AND status = 'unconfirmed' RETURNING id, reference, amount`, [reason, userId || null, id]);
  if (!rows[0]) {
    const { rows: existing } = await pgDb.query('SELECT status FROM paystack_charges WHERE id = $1', [id]);
    if (!existing[0]) throw new QueueError('Charge not found', 404);
    throw new QueueError(`This charge has already been ${existing[0].status}`, 409);
  }
  await logAudit(userId, 'paystack_charge.dismissed', 'paystack_charges', Number(id),
    { reference: rows[0].reference, amount: money(rows[0].amount), note: reason }, ip);
  return { id: rows[0].id, reference: rows[0].reference };
}

async function paystackGet(path) {
  const { data } = await axios.get(`${PAYSTACK_BASE}${path}`, { headers: paystackHeaders(), timeout: 30000 });
  return data;
}

// Every rider with more than one Paystack subscription that can still charge
// them, read live from Paystack. Local records can't answer this: the admin
// link route never wrote any.
async function listDuplicateSubscriptions() {
  const subscriptions = [];
  for (let page = 1; page <= 20; page++) {
    const data = await paystackGet(`/subscription?perPage=100&page=${page}`);
    const rows = data?.data || [];
    subscriptions.push(...rows);
    if (rows.length < 100) break;
  }

  const byEmail = new Map();
  for (const sub of subscriptions) {
    if (!CHARGEABLE.includes(sub.status)) continue;
    const email = String(sub.customer?.email || '').toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email).push(sub);
  }

  const riders = [];
  for (const [email, list] of byEmail) {
    if (list.length < 2) continue;
    const { rows } = await pgDb.query(`
      SELECT u.id, u.full_name, a.id AS agreement_id, a.agreement_no, a.status AS agreement_status, a.weekly_amount
        FROM users u
        LEFT JOIN LATERAL (
          SELECT id, agreement_no, status, weekly_amount FROM agreements WHERE user_id = u.id
           ORDER BY (status = 'active') DESC, id DESC LIMIT 1) a ON TRUE
       WHERE LOWER(u.email) = $1 LIMIT 1`, [email]);
    const user = rows[0];
    riders.push({
      email,
      rider_user_id: user?.id || null,
      rider_name: user?.full_name || null,
      agreement_id: user?.agreement_id || null,
      agreement_no: user?.agreement_no || null,
      agreement_status: user?.agreement_status || null,
      weekly_amount: user?.weekly_amount != null ? money(user.weekly_amount) : null,
      subscriptions: list
        .map((sub) => ({
          subscription_code: sub.subscription_code,
          status: sub.status,
          amount: money((sub.amount || 0) / 100),
          plan_name: sub.plan && typeof sub.plan === 'object' ? sub.plan.name || null : null,
          created_at: sub.createdAt || sub.created_at || null,
          next_payment_date: sub.next_payment_date || null,
        }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    });
  }
  riders.sort((a, b) => b.subscriptions.length - a.subscriptions.length);
  return {
    riders,
    riders_with_duplicates: riders.length,
    chargeable_subscriptions: [...byEmail.values()].reduce((n, list) => n + list.length, 0),
    scanned: subscriptions.length,
  };
}

async function cancelSubscription(code, { userId, ip = null }) {
  if (!/^SUB_[A-Za-z0-9]+$/.test(String(code))) throw new QueueError('That is not a Paystack subscription code');
  const data = await paystackGet(`/subscription/${encodeURIComponent(code)}`);
  const sub = data?.data;
  if (!sub) throw new QueueError('Subscription not found on Paystack', 404);
  if (!CHARGEABLE.includes(sub.status)) throw new QueueError(`This subscription is already ${sub.status}`, 409);
  if (!sub.email_token) throw new QueueError('Paystack did not return the token needed to cancel this subscription', 502);

  await axios.post(`${PAYSTACK_BASE}/subscription/disable`, { code, token: sub.email_token },
    { headers: paystackHeaders(), timeout: 30000 });
  await logAudit(userId, 'paystack_subscription.cancelled', 'paystack_subscriptions', null, {
    subscription_code: code, customer_email: sub.customer?.email || null,
    amount: money((sub.amount || 0) / 100), previous_status: sub.status,
  }, ip);
  return { subscription_code: code, previous_status: sub.status };
}

module.exports = {
  queueCharge, listCharges, confirmCharge, dismissCharge,
  listDuplicateSubscriptions, cancelSubscription, suggestedCredit, QueueError,
};
