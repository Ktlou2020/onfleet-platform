'use strict';

const express = require('express');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpersPg');
const client = require('../services/momo/client');
const momo = require('../services/momo/payments');

const router = express.Router();

// MTN MoMo: the rider's wallet pays the rent, and the fleet owner's wallet
// receives the payout.
//
// ON TRUSTING CALLBACKS, WHICH THIS DOES NOT
//
// MTN's callbacks are unsigned. There is no shared secret and no HMAC, so an
// HTTP POST claiming a payment succeeded is a claim by whoever could reach the
// URL — and the URL is necessarily public. So a callback is treated here as a
// hint and nothing more: it tells us which reference to look at, and then we
// ask MTN ourselves what happened to it. The body is never read for a status.
//
// That is also why the reconciler exists alongside this. A callback that never
// arrives would otherwise leave a rider's money taken and their bike still
// immobilised, which is the worst failure this integration has.

async function refresh(referenceId, direction) {
  const { rows } = await pgDb.query(
    'SELECT * FROM momo_transactions WHERE reference_id = $1 AND direction = $2',
    [referenceId, direction]);
  const tx = rows[0];
  // A reference we never issued. Someone probing, or MTN confused; either way
  // there is nothing of ours to update.
  if (!tx) return null;
  if (tx.status !== 'pending') return tx.status;

  const payload = direction === 'collection'
    ? await client.requestToPayStatus(referenceId)
    : await client.transferStatus(referenceId);
  return momo.applyStatus(tx, payload);
}

for (const direction of ['collection', 'disbursement']) {
  router.put(`/callback/${direction}`, (req, res) => handleCallback(req, res, direction));
  router.post(`/callback/${direction}`, (req, res) => handleCallback(req, res, direction));
}

// Always 200, whatever happens. A callback MTN cannot deliver is one MTN
// retries, and a retry storm over a reference we have already settled helps
// nobody. What matters is written down before this answers.
async function handleCallback(req, res, direction) {
  const referenceId = String(
    req.body?.referenceId || req.body?.externalId || req.query.referenceId || '').trim();
  res.status(200).json({ ok: true });
  if (!referenceId) return;
  try {
    await refresh(referenceId, direction);
  } catch (e) {
    console.error(`[momo] callback for ${referenceId} could not be checked:`, e.message);
  }
}

/**
 * Can this platform take a MoMo payment at all?
 *
 * Open to any signed-in user because the rider's screen has to decide whether
 * to offer the button, and the answer is configuration rather than anything
 * about them. Says nothing about keys, only whether there are any.
 */
router.get('/available', authRequired, async (req, res) => {
  // The caller's own saved number comes back with it, so the rider's screen
  // can offer "pay from this number" rather than asking somebody standing at
  // a bike to type eleven digits they have already given us once.
  const { rows } = await pgDb.query(
    'SELECT momo_msisdn, momo_account_name, momo_verified_at FROM users WHERE id = $1', [req.user.id]);
  res.json({
    available: client.isConfigured('collection'),
    payouts_available: client.isConfigured('disbursement'),
    currency: client.currency(),
    environment: client.env(),
    msisdn: rows[0]?.momo_msisdn || null,
    account_name: rows[0]?.momo_account_name || null,
    verified: !!rows[0]?.momo_verified_at,
  });
});

/** Is a number a real wallet, and whose? Asked before one is ever stored. */
router.post('/verify', authRequired, async (req, res) => {
  try {
    const out = await momo.verifyMsisdn(req.body.msisdn);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * A rider pays their rent from their wallet.
 *
 * Answers as soon as MTN has the request, because that is all that has
 * happened: the rider still has to approve it on their handset. The screen
 * polls /transaction/:reference from here.
 */
router.post('/pay', authRequired, async (req, res) => {
  const amount = Number(req.body.amount);
  const agreementId = Number(req.body.agreement_id) || null;

  const { rows } = await pgDb.query(
    `SELECT a.id, a.bike_id, b.organization_id, u.momo_msisdn
       FROM agreements a
       JOIN bikes b ON b.id = a.bike_id
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND a.user_id = $2`, [agreementId, req.user.id]);
  const agreement = rows[0];
  if (!agreement) return res.status(404).json({ error: 'No agreement of yours by that number' });

  const msisdn = req.body.msisdn || agreement.momo_msisdn;
  if (!msisdn) return res.status(400).json({ error: 'Add your MoMo number first' });

  try {
    const tx = await momo.collectFromRider({
      userId: req.user.id,
      organizationId: agreement.organization_id,
      agreementId: agreement.id,
      amount, msisdn,
    });
    await logAudit(req.user.id, 'momo.request_to_pay', 'momo_transactions', tx.id,
      { amount, agreement_id: agreement.id }, req.ip);
    res.status(202).json({
      reference: tx.reference_id,
      status: 'pending',
      message: 'Approve the payment on your phone — your bike unlocks as soon as it goes through.',
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

/** Where a rider's screen watches for the money to land. */
router.get('/transaction/:reference', authRequired, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT reference_id, direction, status, amount, currency, momo_status, momo_reason,
            requested_at, settled_at, user_id, organization_id
       FROM momo_transactions WHERE reference_id = $1`, [req.params.reference]);
  const tx = rows[0];
  if (!tx) return res.status(404).json({ error: 'No such payment' });

  const mine = tx.user_id === req.user.id;
  const staff = ['admin', 'superadmin'].includes(req.user.role);
  const sameFleet = req.user.organization_id && tx.organization_id === req.user.organization_id;
  if (!mine && !staff && !sameFleet) return res.status(404).json({ error: 'No such payment' });

  // Asked of MTN while it is still open, so a rider watching the screen does
  // not have to wait for the next reconciler sweep to see their bike unlock.
  if (tx.status === 'pending') {
    try { await refresh(tx.reference_id, tx.direction); } catch { /* the stored status stands */ }
    const { rows: again } = await pgDb.query(
      'SELECT status, momo_status, momo_reason, settled_at FROM momo_transactions WHERE reference_id = $1',
      [tx.reference_id]);
    Object.assign(tx, again[0]);
  }
  res.json(tx);
});

/** What the operator needs to see: is it on, what is the float, what moved. */
router.get('/status', authRequired, adminOnly, async (req, res) => {
  const { rows: counts } = await pgDb.query(
    `SELECT direction, status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::numeric AS total
       FROM momo_transactions WHERE requested_at > NOW() - INTERVAL '30 days'
      GROUP BY direction, status`);
  res.json({
    environment: client.env(),
    target_environment: client.targetEnvironment() || null,
    currency: client.currency(),
    collection_configured: client.isConfigured('collection'),
    disbursement_configured: client.isConfigured('disbursement'),
    balances: await momo.balances(),
    last_30_days: counts,
  });
});

router.get('/transactions', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT t.*, o.name AS organization_name, u.full_name AS rider_name
       FROM momo_transactions t
       LEFT JOIN organizations o ON o.id = t.organization_id
       LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.requested_at DESC LIMIT 200`);
  res.json({ transactions: rows });
});

/**
 * Send a pending payout to the fleet owner's wallet.
 *
 * The wallet was already deducted when the request was raised, so this moves
 * the money rather than deciding whether to. It refuses to send twice: a
 * request that already has a transfer against it is left alone, because the
 * failure mode of getting that wrong is paying somebody a second time.
 */
router.post('/payout/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query(
    `SELECT p.*, o.momo_msisdn AS org_msisdn
       FROM fleet_payout_requests p
       JOIN organizations o ON o.id = p.organization_id
      WHERE p.id = $1`, [Number(req.params.id)]);
  const request = rows[0];
  if (!request) return res.status(404).json({ error: 'No such payout request' });
  if (request.status !== 'pending') return res.status(409).json({ error: `That payout is already ${request.status}` });
  if (request.momo_transaction_id) return res.status(409).json({ error: 'A transfer has already been sent for that payout' });
  if (request.payout_method !== 'momo') return res.status(400).json({ error: 'That payout is going to a bank account' });

  try {
    const tx = await momo.payOutToFleet({
      payoutRequestId: request.id,
      organizationId: request.organization_id,
      amount: request.net_payout,
      msisdn: request.momo_msisdn || request.org_msisdn,
    });
    await logAudit(req.user.id, 'momo.payout_sent', 'fleet_payout_requests', request.id,
      { amount: request.net_payout, reference: tx.reference_id }, req.ip);
    res.status(202).json({ reference: tx.reference_id, status: 'pending' });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

/** Ask MTN about everything outstanding, now rather than on the next sweep. */
router.post('/reconcile', authRequired, adminOnly, async (req, res) => {
  try {
    res.json(await momo.reconcile({ limit: Number(req.body.limit) || 50 }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
