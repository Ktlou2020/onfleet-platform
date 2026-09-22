'use strict';

const crypto = require('crypto');
const pgDb = require('../pgDb');

// Which Paystack account takes a rider's payment.
//
// A fleet that has connected its own account collects straight into it: the
// money never passes through us, so there is no float to hold, no cut to take
// and nothing to pay out. A fleet that has not connected one falls back to the
// platform's environment keys — which is how OnFleet Africa's own operation
// works, and why nothing about it changes.
//
// The platform's own keys are used for exactly one other thing: charging
// fleets their subscription. That is our revenue and it stays on our account,
// so routes/fleet.js deliberately does not go through here.

const ALGORITHM = 'aes-256-gcm';

// A 32-byte key, as 64 hex characters or base64. Without it, secrets are not
// stored at all — refusing is better than writing a key that can move a
// customer's money into the database in plain text.
function encryptionKey() {
  const raw = (process.env.CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return buf.length === 32 ? buf : null;
}

function encryptSecret(plaintext) {
  const key = encryptionKey();
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set, so a Paystack secret key cannot be stored safely');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  // iv.tag.ciphertext — the tag is what makes tampering detectable.
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decryptSecret(stored) {
  const key = encryptionKey();
  if (!key || !stored) return null;
  const [ivB64, tagB64, dataB64] = String(stored).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or the ciphertext was altered. Either way it is not usable.
    return null;
  }
}

function newWebhookToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// A key that is obviously a placeholder is worse than none: it fails at
// Paystack with a confusing error instead of here with a clear one.
function looksUsable(key, prefix) {
  const k = String(key || '').trim();
  return k.startsWith(prefix) && !k.includes('xxxx') && k.length > prefix.length + 10;
}

// How a payment for this organisation should be routed. Three ways, in order:
//
//   1. `own`         — the fleet's own Paystack keys. The money goes straight
//                      to them; we never see it.
//   2. `subaccount`  — our keys, with the fleet's subaccount code attached, so
//                      Paystack settles their share directly to their bank.
//                      They never needed a merchant account of their own.
//   3. neither       — our keys alone, which is OnFleet Africa's own operation.
//
// Only the first two mean the money is the fleet's. Both of them mean no
// wallet credit and no fee of ours, because we were never paid.
async function accountForOrganization(organizationId, db = pgDb) {
  const platform = {
    own: false,
    subaccount: null,
    organization_id: organizationId || null,
    secret: process.env.PAYSTACK_SECRET_KEY || null,
    public_key: process.env.PAYSTACK_PUBLIC_KEY || null,
  };
  if (!organizationId) return platform;

  const { rows } = await db.query(
    `SELECT id, paystack_public_key, paystack_secret_key_encrypted, paystack_subaccount_code
       FROM organizations WHERE id = $1`, [organizationId]);
  const org = rows[0];
  if (!org) return platform;

  // A fleet with its own keys is already paid directly; a subaccount would be
  // meaningless there, and on their account our code would not resolve anyway.
  if (!org.paystack_secret_key_encrypted) {
    return { ...platform, subaccount: org.paystack_subaccount_code || null };
  }

  const secret = decryptSecret(org.paystack_secret_key_encrypted);
  // Undecryptable means the encryption key changed or the row was tampered
  // with. Falling back to the platform's account would quietly take the
  // fleet's money into our own, so refuse instead.
  if (!secret) {
    const e = new Error('This fleet\'s Paystack key cannot be read. It must be reconnected before payments can be taken.');
    e.code = 'PAYSTACK_KEY_UNREADABLE';
    throw e;
  }
  // subaccount is explicitly null, not absent: every caller reads the same
  // shape, and a missing key reads as 'not set' exactly like a set one.
  return { own: true, subaccount: null, organization_id: org.id, secret, public_key: org.paystack_public_key || null };
}

// The organisation a rider's agreement belongs to — whose account collects.
async function organizationForAgreement(agreementId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT b.organization_id
       FROM agreements a LEFT JOIN bikes b ON b.id = a.bike_id
      WHERE a.id = $1`, [agreementId]);
  return rows[0]?.organization_id || null;
}

async function connectAccount({ organizationId, secretKey, publicKey, actorId = null, db = pgDb }) {
  if (!looksUsable(secretKey, 'sk_')) throw new Error('That does not look like a Paystack secret key (it should start with sk_)');
  if (publicKey && !looksUsable(publicKey, 'pk_')) throw new Error('That does not look like a Paystack public key (it should start with pk_)');

  const { rows } = await db.query(
    `UPDATE organizations
        SET paystack_secret_key_encrypted = $1,
            paystack_public_key = $2,
            paystack_webhook_token = COALESCE(paystack_webhook_token, $3),
            paystack_connected_at = NOW(),
            paystack_connected_by = $4,
            updated_at = NOW()
      WHERE id = $5
      RETURNING id, name, paystack_public_key, paystack_webhook_token, paystack_connected_at`,
    [encryptSecret(secretKey), publicKey || null, newWebhookToken(), actorId, organizationId]);
  return rows[0] || null;
}

async function disconnectAccount({ organizationId, db = pgDb }) {
  // The webhook token is kept so a webhook still in flight for a payment
  // already taken can still be matched to this fleet and recorded.
  const { rows } = await db.query(
    `UPDATE organizations
        SET paystack_secret_key_encrypted = NULL,
            paystack_public_key = NULL,
            paystack_connected_at = NULL,
            paystack_connected_by = NULL,
            updated_at = NOW()
      WHERE id = $1 RETURNING id, name`, [organizationId]);
  return rows[0] || null;
}

// Paystack subaccount codes look like ACCT_xxxxxxxx. Storing something that
// is not one fails later, inside a payment attempt, where it reads as
// "transaction could not be initialised" and tells nobody why.
function looksLikeSubaccount(code) {
  return /^ACCT_[A-Za-z0-9]{6,}$/.test(String(code || '').trim());
}

async function linkSubaccount({ organizationId, code, name = null, bank = null, actorId = null, db = pgDb }) {
  const trimmed = String(code || '').trim();
  if (!looksLikeSubaccount(trimmed)) {
    throw new Error('That does not look like a Paystack subaccount code (it should start with ACCT_)');
  }
  const { rows } = await db.query(
    `UPDATE organizations
        SET paystack_subaccount_code = $1,
            paystack_subaccount_name = $2,
            paystack_subaccount_bank = $3,
            paystack_subaccount_linked_at = NOW(),
            paystack_subaccount_linked_by = $4,
            updated_at = NOW()
      WHERE id = $5 RETURNING id, name`,
    [trimmed, name || null, bank || null, actorId, organizationId]);
  return rows[0] || null;
}

async function unlinkSubaccount({ organizationId, db = pgDb }) {
  const { rows } = await db.query(
    `UPDATE organizations
        SET paystack_subaccount_code = NULL,
            paystack_subaccount_name = NULL,
            paystack_subaccount_bank = NULL,
            paystack_subaccount_linked_at = NULL,
            paystack_subaccount_linked_by = NULL,
            updated_at = NOW()
      WHERE id = $1 RETURNING id, name`, [organizationId]);
  return rows[0] || null;
}

async function organizationByWebhookToken(token, db = pgDb) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT id, name, paystack_secret_key_encrypted FROM organizations WHERE paystack_webhook_token = $1`, [token]);
  return rows[0] || null;
}

// What the fleet owner is shown. Never the secret — once it is stored, it is
// not ours to hand back, and they already have it from Paystack.
async function connectionStatus(organizationId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT paystack_public_key, paystack_webhook_token, paystack_connected_at,
            paystack_subaccount_code, paystack_subaccount_name,
            paystack_subaccount_bank, paystack_subaccount_linked_at,
            (paystack_secret_key_encrypted IS NOT NULL) AS connected
       FROM organizations WHERE id = $1`, [organizationId]);
  const org = rows[0];
  if (!org) return null;
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  return {
    // How this fleet is actually being paid right now. Own keys win: a
    // subaccount on our account would never see those payments.
    method: org.connected ? 'own_account' : (org.paystack_subaccount_code ? 'subaccount' : 'none'),
    connected: !!org.connected,
    public_key: org.paystack_public_key || null,
    connected_at: org.paystack_connected_at || null,
    // A fleet on its own account signs its own webhooks, so it needs its own
    // URL. A subaccount's payments arrive on ours and need nothing from them.
    webhook_url: org.connected && org.paystack_webhook_token
      ? `${base}/api/payments/paystack/webhook/${org.paystack_webhook_token}`
      : null,
    subaccount: org.paystack_subaccount_code ? {
      code: org.paystack_subaccount_code,
      name: org.paystack_subaccount_name || null,
      bank: org.paystack_subaccount_bank || null,
      linked_at: org.paystack_subaccount_linked_at || null,
    } : null,
  };
}

module.exports = {
  accountForOrganization, organizationForAgreement, organizationByWebhookToken,
  connectAccount, disconnectAccount, connectionStatus,
  linkSubaccount, unlinkSubaccount, looksLikeSubaccount,
  encryptSecret, decryptSecret, newWebhookToken, looksUsable,
};
