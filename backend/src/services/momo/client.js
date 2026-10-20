'use strict';

const axios = require('axios');
const crypto = require('crypto');

// The MTN MoMo Open API, as much of it as this platform needs.
//
// Two products, provisioned and authenticated separately, which is the first
// thing that surprises people: Collection ("Get Paid") pulls money from a
// rider's wallet, Disbursement ("Pay") pushes it to a fleet owner's, and each
// has its own subscription key, its own API user and its own access token.
// Treating them as one credential set is the usual first bug.
//
// The auth chain is three deep. A subscription key identifies the developer
// account and is created on the portal by hand. An API user and API key are
// created against that subscription key — self-service in sandbox, issued by
// MTN in production. Those two then buy a bearer token, good for an hour,
// which is what every real call carries.
//
// Everything here is explicit about which environment it is talking to:
// X-Target-Environment is a header MTN validates against the credentials, so
// a sandbox key with 'mtnsouthafrica' in that header fails rather than
// quietly doing something in the wrong place.

const SANDBOX_BASE = 'https://sandbox.momodeveloper.mtn.com';

const PRODUCTS = {
  collection: { path: 'collection', tokenPath: 'collection/token/' },
  disbursement: { path: 'disbursement', tokenPath: 'disbursement/token/' },
};

function env() {
  return String(process.env.MOMO_ENV || 'sandbox').trim().toLowerCase();
}

function isSandbox() {
  return env() === 'sandbox';
}

function baseUrl() {
  const configured = String(process.env.MOMO_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  return isSandbox() ? SANDBOX_BASE : 'https://proxy.momoapi.mtn.com';
}

/**
 * The environment MTN checks the credentials against.
 *
 * 'sandbox' for the test estate. In production this is the market's own
 * identifier — MTN issues it with the live credentials, and it is not
 * guessable, so it is configuration rather than something derived here.
 */
function targetEnvironment() {
  return String(process.env.MOMO_TARGET_ENVIRONMENT || (isSandbox() ? 'sandbox' : '')).trim();
}

/**
 * The currency to quote.
 *
 * Sandbox only accepts EUR, whatever market you are pretending to be in —
 * a request-to-pay for ZAR there is rejected outright. Production uses the
 * market's own currency. Getting this wrong is the second usual first bug,
 * and it fails in a way that reads like a credentials problem.
 */
function currency() {
  const configured = String(process.env.MOMO_CURRENCY || '').trim().toUpperCase();
  if (configured) return configured;
  return isSandbox() ? 'EUR' : 'ZAR';
}

function credentials(product) {
  const upper = product.toUpperCase();
  return {
    subscriptionKey: String(process.env[`MOMO_${upper}_SUBSCRIPTION_KEY`] || '').trim(),
    apiUser: String(process.env[`MOMO_${upper}_API_USER`] || '').trim(),
    apiKey: String(process.env[`MOMO_${upper}_API_KEY`] || '').trim(),
  };
}

/** Whether this product is wired up enough to call. */
function isConfigured(product = 'collection') {
  const c = credentials(product);
  return !!(c.subscriptionKey && c.apiUser && c.apiKey && targetEnvironment());
}

// Bearer tokens last an hour. Cached per product, and refreshed a minute
// early so a call cannot start with sixty-one minutes on the clock and
// arrive with a token that expired in flight.
const tokens = new Map();
const TOKEN_SAFETY_MS = 60 * 1000;

function http() {
  return axios.create({ baseURL: baseUrl(), timeout: 20000, validateStatus: () => true });
}

async function accessToken(product) {
  const cached = tokens.get(product);
  if (cached && cached.expiresAt > Date.now() + TOKEN_SAFETY_MS) return cached.token;

  const { subscriptionKey, apiUser, apiKey } = credentials(product);
  if (!subscriptionKey || !apiUser || !apiKey) {
    const e = new Error(`MoMo ${product} is not configured`);
    e.code = 'MOMO_NOT_CONFIGURED';
    throw e;
  }

  const basic = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');
  const res = await http().post(`/${PRODUCTS[product].tokenPath}`, null, {
    headers: {
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      Authorization: `Basic ${basic}`,
    },
  });
  if (res.status >= 300 || !res.data?.access_token) {
    throw momoError(`Could not get a ${product} token`, res);
  }
  const ttl = Number(res.data.expires_in || 3600) * 1000;
  tokens.set(product, { token: res.data.access_token, expiresAt: Date.now() + ttl });
  return res.data.access_token;
}

function forgetTokens() { tokens.clear(); }

/**
 * MTN's errors are a code and a message in the body, or nothing at all.
 *
 * Normalised here so the callers never have to guess: the message is what a
 * person reads, `momoCode` is what a person greps for, and `status` is kept
 * because a 409 on a request-to-pay means "you have used that reference
 * before" and a 500 means something else entirely.
 */
function momoError(what, res) {
  const code = res?.data?.code || res?.data?.error || null;
  const detail = res?.data?.message || res?.data?.error_description || '';
  const e = new Error(`${what}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`);
  e.status = res?.status || null;
  e.momoCode = code;
  e.body = res?.data || null;
  return e;
}

async function call(product, { method, path, body = null, referenceId = null, callbackUrl = null }) {
  const token = await accessToken(product);
  const { subscriptionKey } = credentials(product);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
    'X-Target-Environment': targetEnvironment(),
  };
  if (referenceId) headers['X-Reference-Id'] = referenceId;
  if (callbackUrl) headers['X-Callback-Url'] = callbackUrl;
  if (body) headers['Content-Type'] = 'application/json';

  return http().request({ method, url: path, data: body, headers });
}

function callbackUrlFor(kind) {
  const host = String(process.env.MOMO_CALLBACK_HOST || '').trim().replace(/\/$/, '');
  return host ? `${host}/api/momo/callback/${kind}` : null;
}

// ---------------------------------------------------------------- collection

/**
 * Ask a rider to pay.
 *
 * Returns as soon as MTN accepts the request, NOT when the money moves. The
 * rider still has to approve it on their handset, so the transaction sits
 * PENDING until they do, decline, or it times out. The reference we generate
 * is the only handle on it afterwards, so it is returned and stored before
 * anything else can go wrong.
 */
async function requestToPay({ amount, msisdn, externalId, payerMessage, payeeNote, referenceId = crypto.randomUUID() }) {
  const res = await call('collection', {
    method: 'POST',
    path: '/collection/v1_0/requesttopay',
    referenceId,
    callbackUrl: callbackUrlFor('collection'),
    body: {
      amount: String(amount),
      currency: currency(),
      externalId: String(externalId),
      payer: { partyIdType: 'MSISDN', partyId: String(msisdn) },
      payerMessage: String(payerMessage || '').slice(0, 160),
      payeeNote: String(payeeNote || '').slice(0, 160),
    },
  });
  // 202 Accepted is the success case: queued, not yet paid.
  if (res.status !== 202) throw momoError('MoMo would not accept that payment request', res);
  return { referenceId, status: 'PENDING' };
}

async function requestToPayStatus(referenceId) {
  const res = await call('collection', {
    method: 'GET', path: `/collection/v1_0/requesttopay/${referenceId}`,
  });
  if (res.status !== 200) throw momoError('Could not read that payment request', res);
  return res.data;   // { status: PENDING | SUCCESSFUL | FAILED, reason?, ... }
}

async function collectionBalance() {
  const res = await call('collection', { method: 'GET', path: '/collection/v1_0/account/balance' });
  if (res.status !== 200) throw momoError('Could not read the MoMo balance', res);
  return res.data;   // { availableBalance, currency }
}

// -------------------------------------------------------------- disbursement

/** Push money to a wallet — a fleet owner's payout. */
async function transfer({ amount, msisdn, externalId, payerMessage, payeeNote, referenceId = crypto.randomUUID() }) {
  const res = await call('disbursement', {
    method: 'POST',
    path: '/disbursement/v1_0/transfer',
    referenceId,
    callbackUrl: callbackUrlFor('disbursement'),
    body: {
      amount: String(amount),
      currency: currency(),
      externalId: String(externalId),
      payee: { partyIdType: 'MSISDN', partyId: String(msisdn) },
      payerMessage: String(payerMessage || '').slice(0, 160),
      payeeNote: String(payeeNote || '').slice(0, 160),
    },
  });
  if (res.status !== 202) throw momoError('MoMo would not accept that payout', res);
  return { referenceId, status: 'PENDING' };
}

async function transferStatus(referenceId) {
  const res = await call('disbursement', {
    method: 'GET', path: `/disbursement/v1_0/transfer/${referenceId}`,
  });
  if (res.status !== 200) throw momoError('Could not read that payout', res);
  return res.data;
}

async function disbursementBalance() {
  const res = await call('disbursement', { method: 'GET', path: '/disbursement/v1_0/account/balance' });
  if (res.status !== 200) throw momoError('Could not read the payout float', res);
  return res.data;
}

// ------------------------------------------------------------------ identity

/**
 * Is this number a MoMo account at all?
 *
 * Asked before a number is ever stored as somebody's payout destination. A
 * disbursement to a mistyped MSISDN is not a failed payment, it is a
 * successful one to a stranger, and no part of this system can get it back.
 */
async function isAccountActive(msisdn, product = 'disbursement') {
  const res = await call(product, {
    method: 'GET', path: `/${PRODUCTS[product].path}/v1_0/accountholder/msisdn/${encodeURIComponent(msisdn)}/active`,
  });
  if (res.status === 200) return res.data === true || res.data?.result === true;
  if (res.status === 404) return false;
  throw momoError('Could not check that MoMo number', res);
}

/** The name MTN holds for a number, so a person can confirm it before sending. */
async function accountHolderName(msisdn, product = 'disbursement') {
  const res = await call(product, {
    method: 'GET', path: `/${PRODUCTS[product].path}/v1_0/accountholder/msisdn/${encodeURIComponent(msisdn)}/basicuserinfo`,
  });
  if (res.status !== 200) return null;
  return res.data?.name || [res.data?.given_name, res.data?.family_name].filter(Boolean).join(' ') || null;
}

// ---------------------------------------------------------- sandbox set-up

/**
 * Create the API user and key a sandbox needs, from a subscription key alone.
 *
 * Only possible in sandbox — in production MTN issues these — and written to
 * be run once by hand rather than on boot, because it mints credentials and
 * that is not something a deploy should do on its own.
 */
async function provisionSandboxUser(product, { callbackHost = 'example.com' } = {}) {
  if (!isSandbox()) throw new Error('API users can only be self-provisioned in sandbox');
  const { subscriptionKey } = credentials(product);
  if (!subscriptionKey) throw new Error(`No MOMO_${product.toUpperCase()}_SUBSCRIPTION_KEY set`);

  const apiUser = crypto.randomUUID();
  const h = { 'Ocp-Apim-Subscription-Key': subscriptionKey, 'Content-Type': 'application/json' };

  const made = await http().post('/v1_0/apiuser', { providerCallbackHost: callbackHost },
    { headers: { ...h, 'X-Reference-Id': apiUser } });
  if (made.status !== 201) throw momoError('Could not create a sandbox API user', made);

  const key = await http().post(`/v1_0/apiuser/${apiUser}/apikey`, null, { headers: h });
  if (key.status !== 201 || !key.data?.apiKey) throw momoError('Could not create a sandbox API key', key);

  return { apiUser, apiKey: key.data.apiKey };
}

module.exports = {
  requestToPay, requestToPayStatus, collectionBalance,
  transfer, transferStatus, disbursementBalance,
  isAccountActive, accountHolderName,
  provisionSandboxUser, accessToken, forgetTokens,
  isConfigured, isSandbox, baseUrl, currency, targetEnvironment, env,
  PRODUCTS,
};
