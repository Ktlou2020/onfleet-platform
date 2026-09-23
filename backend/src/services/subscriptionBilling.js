'use strict';

const axios = require('axios');
const { v4: uuid } = require('uuid');
const pgDb = require('../pgDb');
const pricing = require('./subscriptionPricing');
const dunning = require('./subscriptionDunning');
const { encryptSecret, decryptSecret } = require('./paystackAccounts');

// Charging a fleet for the bikes it has.
//
// Paystack's charge_authorization takes a saved card and an arbitrary amount,
// which is what per-bike pricing needs and what a fixed subscription plan
// cannot give. The first payment is an ordinary checkout; it returns an
// authorisation we keep, and every month after that we work out the amount and
// charge it.
//
// The rule this is built around: never charge a fleet twice for one month. A
// scheduler that runs twice, a retry after a timeout, a webhook arriving late
// — all of them must end with one invoice. The period row is claimed in the
// database before any money moves, and a unique index makes a second claim
// impossible rather than unlikely.

const PAYSTACK_BASE = 'https://api.paystack.co';

function firstOfMonth(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1));
}

function asDate(d) {
  return d.toISOString().slice(0, 10);
}

/** The period a charge made now would cover. */
function periodFor(cycle, when = new Date()) {
  const start = firstOfMonth(when);
  return { start: asDate(start), end: asDate(addMonths(start, cycle === 'annual' ? 12 : 1)) };
}

function storeAuthorization(code) {
  return encryptSecret(code);
}

function readAuthorization(stored) {
  return decryptSecret(stored);
}

/**
 * Remember the card a fleet paid with, so later months can be charged without
 * sending them back to a checkout page.
 *
 * Paystack only returns a reusable authorisation when the card supports it;
 * one that does not is not stored, because saving something unusable would
 * read as "card on file" and fail every month.
 */
async function rememberAuthorization({ organizationId, authorization, email, db = pgDb }) {
  if (!authorization?.authorization_code) return null;
  if (authorization.reusable === false) {
    const e = new Error('That card cannot be saved for future payments. Please use another card.');
    e.code = 'CARD_NOT_REUSABLE';
    throw e;
  }
  const { rows } = await db.query(
    `UPDATE organizations
        SET billing_authorization_encrypted = $1,
            billing_card_last4 = $2,
            billing_card_brand = $3,
            billing_card_expiry = $4,
            billing_email = COALESCE($5, billing_email),
            billing_failure_count = 0,
            updated_at = NOW()
      WHERE id = $6
      RETURNING id, billing_card_last4, billing_card_brand, billing_card_expiry`,
    [
      storeAuthorization(authorization.authorization_code),
      authorization.last4 || null,
      authorization.brand || null,
      authorization.exp_month && authorization.exp_year ? `${authorization.exp_month}/${authorization.exp_year}` : null,
      email || null,
      organizationId,
    ]);
  return rows[0] || null;
}

/**
 * Claim this organisation's period before charging it.
 *
 * Returns null when the period is already paid — which is the whole point.
 * Two schedulers racing both reach here; the unique index lets exactly one
 * insert a row, and the other gets null and does nothing.
 */
async function claimPeriod({ organizationId, quote, period, db = pgDb }) {
  const reference = `PIL-${uuid().slice(0, 12)}`;
  const { rows } = await db.query(
    `INSERT INTO subscription_invoices
       (organization_id, reference, tier, cycle, per_bike_monthly, bikes, charged_bikes,
        months_charged, amount, description, bike_breakdown, status, period_start, period_end)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13
      WHERE NOT EXISTS (
        SELECT 1 FROM subscription_invoices
         WHERE organization_id = $1 AND period_start = $12 AND status IN ('paid', 'pending')
      )
     RETURNING *`,
    [organizationId, reference, quote.tier, quote.cycle, quote.per_bike_monthly, quote.bikes,
     quote.charged_bikes, quote.months_charged, quote.total, quote.description,
     JSON.stringify(quote.bike_breakdown || null), period.start, period.end]);
  return rows[0] || null;
}

async function markInvoice(invoiceId, fields, db = pgDb) {
  const { rows } = await db.query(
    `UPDATE subscription_invoices
        SET status = COALESCE($2, status),
            failure_reason = $3,
            paystack_reference = COALESCE($4, paystack_reference),
            charged_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE charged_at END
      WHERE id = $1 RETURNING *`,
    [invoiceId, fields.status || null, fields.failureReason || null, fields.paystackReference || null]);
  return rows[0] || null;
}

/**
 * Charge one fleet for the current period.
 *
 * Every early return is a reason not to take money, and each says which, so a
 * fleet that was not charged can be told why rather than discovering it in a
 * suspended account.
 */
async function chargeOrganization(organizationId, { when = new Date(), db = pgDb } = {}) {
  const { rows } = await db.query(
    `SELECT id, name, subscription_tier, subscription_cycle, subscription_status,
            billing_authorization_encrypted, billing_email, contact_email
       FROM organizations WHERE id = $1`, [organizationId]);
  const org = rows[0];
  if (!org) return { skipped: 'no such organisation' };
  if (org.subscription_status === 'cancelled') return { skipped: 'subscription cancelled' };
  if (!org.subscription_tier) return { skipped: 'no plan chosen' };
  if (!org.billing_authorization_encrypted) return { skipped: 'no card on file' };

  const authorization = readAuthorization(org.billing_authorization_encrypted);
  // Unreadable means the encryption key changed. Charging is impossible and
  // guessing is not an option, so say so rather than failing silently.
  if (!authorization) return { skipped: 'card on file cannot be read — it must be re-entered' };

  const quote = await pricing.quoteForOrganization(organizationId, {}, db);
  const period = periodFor(org.subscription_cycle || 'monthly', when);

  const invoice = await claimPeriod({ organizationId, quote, period, db });
  if (!invoice) return { skipped: 'already invoiced for this period' };

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    await markInvoice(invoice.id, { status: 'failed', failureReason: 'Paystack is not configured' }, db);
    return { invoice, charged: false, reason: 'Paystack is not configured' };
  }

  try {
    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/charge_authorization`, {
      authorization_code: authorization,
      email: org.billing_email || org.contact_email,
      amount: quote.amount_kobo,
      currency: 'ZAR',
      reference: invoice.reference,
      metadata: {
        organization_id: organizationId,
        subscription_invoice_id: invoice.id,
        bikes: quote.bikes,
        charged_bikes: quote.charged_bikes,
        tier: quote.tier,
      },
    }, { headers: { Authorization: `Bearer ${secret}` } });

    const data = resp.data?.data;
    if (data?.status === 'success') {
      await markInvoice(invoice.id, { status: 'paid', paystackReference: data.reference }, db);
      await dunning.recordSuccess({ organizationId, nextBillingDate: period.end, db });
      return { invoice, charged: true, amount: quote.total };
    }

    const reason = data?.gateway_response || 'The card was declined';
    const failed = await markInvoice(invoice.id, { status: 'failed', failureReason: reason, paystackReference: data?.reference }, db);
    const chase = await dunning.recordFailure({ organizationId, invoice: failed || invoice, reason, when, db });
    return { invoice, charged: false, reason, chase };
  } catch (e) {
    const reason = e.response?.data?.message || e.message;
    const failed = await markInvoice(invoice.id, { status: 'failed', failureReason: reason }, db);
    const chase = await dunning.recordFailure({ organizationId, invoice: failed || invoice, reason, when, db });
    return { invoice, charged: false, reason, chase };
  }
}

/**
 * Every fleet due a charge today.
 *
 * This runs daily, so the thing it has to get right is not charging a card
 * that was declined this morning. A fleet being chased is due only on the day
 * its schedule says, and once the attempts are used up it is not due at all —
 * it is waiting to be suspended, or for someone to come and fix the card.
 */
async function organizationsDue({ when = new Date(), db = pgDb } = {}) {
  const today = asDate(when);
  const { rows } = await db.query(
    `SELECT id FROM organizations
      WHERE subscription_tier IS NOT NULL
        AND billing_authorization_encrypted IS NOT NULL
        AND (
          (subscription_status = 'active'
             AND (next_billing_date IS NULL OR next_billing_date <= $1))
          OR
          (subscription_status = 'past_due'
             AND billing_retry_at IS NOT NULL AND billing_retry_at <= $1)
        )
      ORDER BY id`, [today]);
  return rows.map((r) => r.id);
}

/**
 * The daily pass: charge what is due, then pause anyone whose grace period
 * ran out without the money arriving.
 *
 * Suspension comes after charging, so a fleet whose retry succeeds on the
 * last morning is not paused an hour later by the same run.
 */
async function runBillingRun({ when = new Date(), db = pgDb } = {}) {
  const ids = await organizationsDue({ when, db });
  const charges = [];
  for (const id of ids) {
    // One fleet's failure must not stop the rest of the run.
    try {
      charges.push({ organizationId: id, ...(await chargeOrganization(id, { when, db })) });
    } catch (e) {
      console.error('[billing] charge failed for organisation', id, e.message);
      charges.push({ organizationId: id, charged: false, reason: e.message });
    }
  }

  let suspended = [];
  try {
    suspended = await dunning.suspendExpired({ when, db });
  } catch (e) {
    // A suspension that fails must not make the run look like it never
    // charged anyone — the money it took is still the important part.
    console.error('[billing] suspension pass failed:', e.message);
  }

  return { charges, suspended };
}

module.exports = {
  chargeOrganization, runBillingRun, organizationsDue,
  rememberAuthorization, claimPeriod, markInvoice, periodFor,
  storeAuthorization, readAuthorization,
};
