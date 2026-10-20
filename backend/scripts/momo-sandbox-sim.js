'use strict';

/**
 * A stand-in for MTN MoMo, for demonstrating the integration before
 * credentials exist — and for testing it afterwards without moving money.
 *
 * Implements the handful of endpoints this platform actually calls, with the
 * behaviour that matters: a request-to-pay is ACCEPTED immediately and stays
 * PENDING until the payer "approves" it, exactly as the real one does. That
 * delay is the whole shape of the integration, so a simulator that answered
 * SUCCESSFUL straight away would prove nothing.
 *
 *   node scripts/momo-sandbox-sim.js [port]
 *
 * Point the platform at it:
 *   MOMO_BASE_URL=http://localhost:4100
 *   MOMO_TARGET_ENVIRONMENT=sandbox
 *   MOMO_COLLECTION_SUBSCRIPTION_KEY=sim   (any non-empty value)
 *   MOMO_COLLECTION_API_USER=sim
 *   MOMO_COLLECTION_API_KEY=sim
 *   ...and the same four for DISBURSEMENT.
 *
 * Approval is automatic after MOMO_SIM_APPROVE_AFTER_MS (default 6s), which
 * is long enough to watch the rider's screen wait and then change. Set
 * MOMO_SIM_OUTCOME=failed to rehearse the unhappy path, or drive it by hand:
 *
 *   POST /_sim/approve/:referenceId
 *   POST /_sim/decline/:referenceId
 *   GET  /_sim/transactions
 */

const express = require('express');

const app = express();
app.use(express.json());

const PORT = Number(process.argv[2] || process.env.MOMO_SIM_PORT || 4100);
const APPROVE_AFTER_MS = Number(process.env.MOMO_SIM_APPROVE_AFTER_MS || 6000);
const DEFAULT_OUTCOME = String(process.env.MOMO_SIM_OUTCOME || 'successful').toLowerCase();

const txns = new Map();

const log = (...a) => console.log('[momo-sim]', ...a);

function accept(req, res, kind) {
  const referenceId = req.get('X-Reference-Id');
  if (!referenceId) return res.status(400).json({ code: 'MISSING_REFERENCE', message: 'X-Reference-Id is required' });
  if (txns.has(referenceId)) {
    // The real one refuses a reference it has seen before. Worth having,
    // because reusing a reference is a real bug with a confusing symptom.
    return res.status(409).json({ code: 'DUPLICATE_REFERENCE_ID', message: 'That reference has been used' });
  }

  const body = req.body || {};
  const party = kind === 'collection' ? body.payer : body.payee;
  txns.set(referenceId, {
    referenceId, kind, status: 'PENDING',
    amount: body.amount, currency: body.currency, externalId: body.externalId,
    msisdn: party?.partyId || null,
    callback: req.get('X-Callback-Url') || null,
    createdAt: Date.now(),
  });
  log(`${kind} ${referenceId} accepted — ${body.currency} ${body.amount} ${kind === 'collection' ? 'from' : 'to'} ${party?.partyId}`);

  if (APPROVE_AFTER_MS >= 0) {
    setTimeout(() => settle(referenceId, DEFAULT_OUTCOME), APPROVE_AFTER_MS).unref?.();
  }
  res.status(202).end();
}

function settle(referenceId, outcome) {
  const t = txns.get(referenceId);
  if (!t || t.status !== 'PENDING') return;
  t.status = outcome === 'failed' ? 'FAILED' : 'SUCCESSFUL';
  if (t.status === 'FAILED') t.reason = 'PAYER_LIMIT_REACHED';
  log(`${t.kind} ${referenceId} -> ${t.status}`);
}

function statusOf(req, res) {
  const t = txns.get(req.params.referenceId);
  if (!t) return res.status(404).json({ code: 'RESOURCE_NOT_FOUND', message: 'No such transaction' });
  res.json({
    financialTransactionId: String(100000 + [...txns.keys()].indexOf(t.referenceId)),
    externalId: t.externalId, amount: t.amount, currency: t.currency,
    status: t.status, reason: t.reason,
    [t.kind === 'collection' ? 'payer' : 'payee']: { partyIdType: 'MSISDN', partyId: t.msisdn },
  });
}

// --- auth -------------------------------------------------------------
for (const product of ['collection', 'disbursement']) {
  app.post(`/${product}/token/`, (req, res) => {
    if (!req.get('Authorization')?.startsWith('Basic ')) {
      return res.status(401).json({ code: 'NOT_ALLOWED', message: 'Basic auth required' });
    }
    res.json({ access_token: `sim-${product}-${Date.now()}`, token_type: 'access_token', expires_in: 3600 });
  });
}

// --- collection -------------------------------------------------------
app.post('/collection/v1_0/requesttopay', (req, res) => accept(req, res, 'collection'));
app.get('/collection/v1_0/requesttopay/:referenceId', statusOf);
app.get('/collection/v1_0/account/balance', (_req, res) =>
  res.json({ availableBalance: '128400.00', currency: process.env.MOMO_CURRENCY || 'EUR' }));

// --- disbursement -----------------------------------------------------
app.post('/disbursement/v1_0/transfer', (req, res) => accept(req, res, 'disbursement'));
app.get('/disbursement/v1_0/transfer/:referenceId', statusOf);
app.get('/disbursement/v1_0/account/balance', (_req, res) =>
  res.json({ availableBalance: '64250.00', currency: process.env.MOMO_CURRENCY || 'EUR' }));

// --- account holder ---------------------------------------------------
const KNOWN_NAMES = { 27821234567: 'Thabo Mokoena', 27831234567: 'Moyo Bikes (Pty) Ltd' };
for (const product of ['collection', 'disbursement']) {
  app.get(`/${product}/v1_0/accountholder/msisdn/:msisdn/active`, (req, res) => {
    // A number ending 0000 is the one that does not exist, so the refusal
    // path can be demonstrated on purpose rather than by accident.
    if (String(req.params.msisdn).endsWith('0000')) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json(true);
  });
  app.get(`/${product}/v1_0/accountholder/msisdn/:msisdn/basicuserinfo`, (req, res) => {
    const name = KNOWN_NAMES[req.params.msisdn] || 'MoMo Account Holder';
    const [given, ...rest] = name.split(' ');
    res.json({ name, given_name: given, family_name: rest.join(' ') });
  });
}

// --- driving it by hand ----------------------------------------------
app.post('/_sim/approve/:referenceId', (req, res) => { settle(req.params.referenceId, 'successful'); res.json({ ok: true }); });
app.post('/_sim/decline/:referenceId', (req, res) => { settle(req.params.referenceId, 'failed'); res.json({ ok: true }); });
app.get('/_sim/transactions', (_req, res) => res.json({ transactions: [...txns.values()] }));

app.listen(PORT, () => {
  log(`standing in for MTN MoMo on http://localhost:${PORT}`);
  log(`requests settle as ${DEFAULT_OUTCOME.toUpperCase()} after ${APPROVE_AFTER_MS}ms`);
});
