'use strict';

const crypto = require('crypto');
const pgDb = require('../../pgDb');
const client = require('./client');
const { restoreEngine, deviceForBike } = require('../engineRestore');

// Money in from riders, money out to fleet owners, over MTN MoMo.
//
// The shape of every flow here is the same, and it is not the shape of a card
// payment: MTN accepts the instruction and answers later. A request-to-pay
// returns 202 while the rider still has their phone in their pocket, and the
// money moves — or does not — when they approve it. So nothing in this file
// treats a successful API call as a payment. The transaction row is written
// first, in 'pending', and only MTN's own status moves it on.
//
// That is also why the reference id is generated here rather than taken from
// a response. It is the only handle on a transaction that exists before the
// transaction does, and a request we sent without recording its reference is
// money we cannot ask MTN about.

// How long a pending request-to-pay blocks another for the same agreement.
//
// A rider on a patchy connection taps Pay, sees nothing happen, and taps
// again. Without this that is two prompts on their handset and, if they
// approve both, two payments — and the second is money we have to give back
// rather than money we can keep. MTN's own prompt expires well inside this,
// so a request still pending after it is dead rather than waiting.
const DUPLICATE_WINDOW_MINUTES = Number(process.env.MOMO_DUPLICATE_WINDOW_MINUTES || 15);

const PLATFORM_FEE_RATE = Number(process.env.MOMO_FEE_RATE ?? 0.015);
const PLATFORM_FEE_FIXED = Number(process.env.MOMO_FEE_FIXED ?? 0);

/**
 * Normalise a number to what MTN expects: digits, country code, no plus.
 *
 * South African numbers are typed every way a person can type them —
 * 082 123 4567, +27 82 123 4567, 0027821234567 — and MTN wants 27821234567.
 * A number that cannot be made sense of is returned null rather than guessed
 * at, because a guess here is money sent to whoever owns the guess.
 */
function normaliseMsisdn(input, { countryCode = process.env.MOMO_COUNTRY_CODE || '27' } = {}) {
  let digits = String(input || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith(countryCode) && digits.length >= 11) return digits;
  if (digits.startsWith('0')) return `${countryCode}${digits.slice(1)}`;
  if (digits.length === 9) return `${countryCode}${digits}`;
  return digits.length >= 11 ? digits : null;
}

/**
 * Is this a live MoMo wallet, and whose?
 *
 * Asked before a number is ever stored as a payout destination. A transfer to
 * a mistyped MSISDN is not a failed payment — it is a successful payment to a
 * stranger, and nothing in this system can claw it back.
 */
async function verifyMsisdn(raw) {
  const msisdn = normaliseMsisdn(raw);
  if (!msisdn) return { ok: false, reason: 'That does not look like a phone number' };
  if (!client.isConfigured('disbursement')) {
    return { ok: false, reason: 'MoMo is not connected yet', unconfigured: true };
  }
  const active = await client.isAccountActive(msisdn);
  if (!active) return { ok: false, msisdn, reason: 'MTN does not recognise that number as a MoMo wallet' };
  const name = await client.accountHolderName(msisdn).catch(() => null);
  return { ok: true, msisdn, name };
}

async function record({ referenceId, direction, amount, msisdn, externalId, ...links }, db = pgDb) {
  const { rows } = await db.query(
    `INSERT INTO momo_transactions
       (reference_id, direction, status, amount, currency, msisdn, external_id,
        organization_id, user_id, agreement_id, payment_schedule_id, payout_request_id)
     VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [referenceId, direction, amount, client.currency(), msisdn, externalId,
      links.organizationId || null, links.userId || null, links.agreementId || null,
      links.paymentScheduleId || null, links.payoutRequestId || null]);
  return rows[0];
}

/**
 * Ask a rider to pay their weekly rent from their wallet.
 *
 * The row exists before MTN is called. If the call then fails the row is
 * marked failed and we know exactly what was attempted; if the process dies
 * between the two, the reconciler finds a pending row with a reference MTN
 * has never heard of and closes it. The alternative — call first, record
 * after — loses the reference on any crash, and a payment nobody can look up
 * is a payment that gets taken twice.
 */
async function collectFromRider({
  userId, organizationId, agreementId, paymentScheduleId,
  amount, msisdn: rawMsisdn, reference = null, db = pgDb,
}) {
  const msisdn = normaliseMsisdn(rawMsisdn);
  if (!msisdn) throw Object.assign(new Error('No usable MoMo number for that rider'), { status: 400 });
  if (!(Number(amount) > 0)) throw Object.assign(new Error('Nothing to collect'), { status: 400 });

  // One prompt at a time. Returns the request already in flight rather than
  // refusing, so a second tap lands the rider's screen back on the payment
  // they already started instead of showing them an error.
  const { rows: inFlight } = await db.query(
    `SELECT * FROM momo_transactions
      WHERE direction = 'collection' AND status = 'pending'
        AND user_id = $1 AND COALESCE(agreement_id, 0) = COALESCE($2, 0)
        AND requested_at > NOW() - ($3 || ' minutes')::interval
      ORDER BY requested_at DESC LIMIT 1`,
    [userId, agreementId || null, String(DUPLICATE_WINDOW_MINUTES)]);
  if (inFlight[0]) return { ...inFlight[0], already_pending: true };

  const referenceId = crypto.randomUUID();
  const externalId = reference || `RENT-${agreementId || userId}-${Date.now()}`;
  const tx = await record({
    referenceId, direction: 'collection', amount, msisdn, externalId,
    userId, organizationId, agreementId, paymentScheduleId,
  }, db);

  try {
    await client.requestToPay({
      amount, msisdn, externalId, referenceId,
      payerMessage: 'Weekly bike rental',
      payeeNote: `Rental ${externalId}`,
    });
    return { ...tx, status: 'pending' };
  } catch (e) {
    await db.query(
      `UPDATE momo_transactions SET status='failed', momo_reason=$1, settled_at=NOW() WHERE id=$2`,
      [e.message.slice(0, 500), tx.id]);
    throw e;
  }
}

/** Pay a fleet owner out to their wallet. */
async function payOutToFleet({ payoutRequestId, organizationId, amount, msisdn: rawMsisdn, db = pgDb }) {
  const msisdn = normaliseMsisdn(rawMsisdn);
  if (!msisdn) throw Object.assign(new Error('No usable MoMo number for that fleet'), { status: 400 });

  const referenceId = crypto.randomUUID();
  const externalId = `PAYOUT-${payoutRequestId}`;
  const tx = await record({
    referenceId, direction: 'disbursement', amount, msisdn, externalId,
    organizationId, payoutRequestId,
  }, db);

  await db.query('UPDATE fleet_payout_requests SET momo_transaction_id = $1 WHERE id = $2',
    [tx.id, payoutRequestId]);

  try {
    await client.transfer({
      amount, msisdn, externalId, referenceId,
      payerMessage: 'Fleet payout', payeeNote: `Payout ${externalId}`,
    });
    return { ...tx, status: 'pending' };
  } catch (e) {
    await db.query(
      `UPDATE momo_transactions SET status='failed', momo_reason=$1, settled_at=NOW() WHERE id=$2`,
      [e.message.slice(0, 500), tx.id]);
    throw e;
  }
}

// ------------------------------------------------------------- settlement

/**
 * A rider's payment has actually landed.
 *
 * Credits the fleet's wallet and, if that bike was cut for arrears, lets it
 * run again. The second half is the point of the whole integration: a rider
 * standing next to a bike that will not start pays from the phone in their
 * hand and rides away, without anybody at a desk being involved.
 *
 * Idempotent on the wallet credit through the same unique index the card
 * webhook uses, because MTN will deliver a callback and the reconciler will
 * also find the transaction, and both are supposed to be safe.
 */
async function settleCollection(tx, { db = pgDb } = {}) {
  const gross = Number(tx.amount);
  const fee = +(gross * PLATFORM_FEE_RATE + PLATFORM_FEE_FIXED).toFixed(2);
  const net = +(gross - fee).toFixed(2);
  const result = { credited: false, unlocked: false };

  if (tx.organization_id) {
    await db.query(
      `INSERT INTO fleet_wallets (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
      [tx.organization_id]);
    await pgDb.withTransaction(async (c) => {
      // paystack_reference is the provider's reference, whichever provider.
      // A MoMo reference is a UUID and cannot collide with a Paystack one,
      // and reusing the column means reusing its unique index — which is the
      // thing that makes a callback and a reconciler sweep safe together.
      const { rows } = await c.query(
        `INSERT INTO fleet_wallet_transactions
           (organization_id, type, amount, fee_amount, net_amount, description,
            paystack_reference, rider_user_id, available_at)
         VALUES ($1,'credit',$2,$3,$4,'Weekly rider rental payment (MoMo)',$5,$6, NOW())
         ON CONFLICT (paystack_reference) WHERE type = 'credit' AND paystack_reference IS NOT NULL
         DO NOTHING RETURNING id`,
        [tx.organization_id, gross, fee, net, tx.reference_id, tx.user_id || null]);
      if (!rows[0]) return;
      await c.query(
        `UPDATE fleet_wallets SET balance = balance + $1, total_collected = total_collected + $1, updated_at = NOW()
          WHERE organization_id = $2`, [net, tx.organization_id]);
      result.credited = true;
    });
  }

  // And the bike runs again.
  if (tx.agreement_id) {
    const { rows } = await db.query('SELECT bike_id FROM agreements WHERE id = $1', [tx.agreement_id]);
    const bikeId = rows[0]?.bike_id;
    if (bikeId) {
      const device = await deviceForBike(bikeId, db);
      // Only a cut this payment actually answers. A bike stopped because it
      // was stolen does not start again because the rent arrived.
      const forArrears = /arrear|payment|overdue|rental/i.test(device?.engine_cut_reason || '');
      if (device?.engine_cut_active && forArrears) {
        const out = await restoreEngine(device.id, { db });
        result.unlocked = out.restored;
        if (out.restored) {
          console.log(`[momo] bike ${bikeId} unlocked — rider paid ${tx.currency} ${gross} from their wallet`);
          require('../engineCutNotifier')
            .notifyRiderEngineState(bikeId, 'restored', { reason: 'Payment received', automatic: true })
            .catch((e) => console.error('[momo] rider notify failed:', e.message));
        }
      }
    }
  }

  return result;
}

/**
 * Bring our view of a transaction into line with MTN's.
 *
 * The single place a transaction changes state, whether the news arrived by
 * callback or by asking. Returns null when nothing moved, so a caller can
 * tell the difference between "still pending" and "just settled".
 */
async function applyStatus(tx, payload, { db = pgDb } = {}) {
  const momoStatus = String(payload?.status || '').toUpperCase();
  const next = momoStatus === 'SUCCESSFUL' ? 'successful'
    : momoStatus === 'FAILED' ? 'failed'
      : 'pending';

  await db.query(
    `UPDATE momo_transactions
        SET momo_status = $1, momo_reason = $2, last_payload = $3, checked_at = NOW(),
            status = $4, settled_at = CASE WHEN $4 <> 'pending' THEN NOW() ELSE settled_at END
      WHERE id = $5`,
    [momoStatus || null, payload?.reason ? String(payload.reason).slice(0, 500) : null,
      JSON.stringify(payload || {}).slice(0, 4000), next, tx.id]);

  if (next !== 'successful' || tx.status === 'successful') return next === 'pending' ? null : next;

  if (tx.direction === 'collection') await settleCollection(tx, { db });
  if (tx.direction === 'disbursement' && tx.payout_request_id) {
    await db.query(
      `UPDATE fleet_payout_requests SET status = 'paid', processed_at = NOW() WHERE id = $1 AND status <> 'paid'`,
      [tx.payout_request_id]);
  }
  return next;
}

/**
 * Ask MTN about everything still in the air.
 *
 * Runs alongside the callbacks rather than instead of them. A callback that
 * never arrives — a deploy mid-flight, a URL MTN could not reach — would
 * otherwise leave a rider's payment taken and their bike still immobilised,
 * which is the worst failure this integration has.
 */
async function reconcile({ limit = 50, db = pgDb } = {}) {
  if (!client.isConfigured('collection') && !client.isConfigured('disbursement')) {
    return { checked: 0, settled: 0, skipped: 'not configured' };
  }
  const { rows } = await db.query(
    `SELECT * FROM momo_transactions WHERE status = 'pending' ORDER BY requested_at LIMIT $1`, [limit]);

  let settled = 0;
  for (const tx of rows) {
    try {
      const payload = tx.direction === 'collection'
        ? await client.requestToPayStatus(tx.reference_id)
        : await client.transferStatus(tx.reference_id);
      const moved = await applyStatus(tx, payload, { db });
      if (moved === 'successful' || moved === 'failed') settled += 1;
    } catch (e) {
      await db.query('UPDATE momo_transactions SET checked_at = NOW() WHERE id = $1', [tx.id]);
      console.error(`[momo] could not check ${tx.reference_id}:`, e.message);
    }
  }
  if (settled) console.log(`[momo] settled ${settled} of ${rows.length} pending transaction(s)`);
  return { checked: rows.length, settled };
}

/** The float, both ways, for the admin dashboard. */
async function balances() {
  const out = { collection: null, disbursement: null };
  if (client.isConfigured('collection')) {
    out.collection = await client.collectionBalance().catch((e) => ({ error: e.message }));
  }
  if (client.isConfigured('disbursement')) {
    out.disbursement = await client.disbursementBalance().catch((e) => ({ error: e.message }));
  }
  return out;
}

module.exports = {
  collectFromRider, payOutToFleet, reconcile, applyStatus, settleCollection,
  verifyMsisdn, normaliseMsisdn, balances,
  PLATFORM_FEE_RATE, PLATFORM_FEE_FIXED, DUPLICATE_WINDOW_MINUTES,
};
