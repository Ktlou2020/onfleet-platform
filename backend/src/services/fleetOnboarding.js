'use strict';

// Putting a new fleet on the platform.
//
// There have been two ways to do this and they were about to become three.
// A fleet owner could sign themselves up at /auth/fleet/signup, and pilot.js
// had its own copy of the plan entitlements to do much the same thing. Both
// wrote the same two rows in the same order with the same rules, separately.
//
// On a telematics deployment the important path is neither of those: somebody
// on a sales call needs to create the account themselves, pick the plan, and
// have the customer set their own password afterwards. That is a third caller
// for the same transaction, so the transaction moves here rather than being
// written out a third time.
//
// The one real difference between the callers is the password. Self-serve
// signup has one, because the person is sitting at the form. Onboarding by an
// operator must not: inventing a password for somebody and emailing it is how
// shared credentials start. That caller passes none, gets a user who cannot
// log in until they set one, and sends an invite.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pgDb = require('../pgDb');

// What each plan lets a fleet do.
//
// There were three copies of this — here, in routes/admin.js and in
// routes/pilot.js — and they disagreed on both the numbers and the names.
// Two of them offered a plan called `empire`; the organizations table only
// accepts trial, small, medium, large and enterprise, so onboarding a fleet
// on Empire failed with a check-constraint violation and a 500. The plan was
// on the form and could never have worked.
//
// The numbers here are admin.js's, because that copy is the one that governed
// a live account: it is what an operator changing somebody's plan actually
// applied. The others would have quietly given a self-serve trial six bikes
// where an operator-assigned trial gave ten.
//
// `status` travels with the plan for the same reason. A fleet put on a paid
// plan is active; a trial is trialing. Keeping that beside the limits stops
// the two being set from different places and disagreeing.
const FLEET_PLAN_ENTITLEMENTS = {
  trial: { status: 'trialing', max_bikes: 10, max_admin_users: 2 },
  small: { status: 'active', max_bikes: 20, max_admin_users: 3 },
  medium: { status: 'active', max_bikes: 60, max_admin_users: 5 },
  large: { status: 'active', max_bikes: 100, max_admin_users: 10 },
  enterprise: { status: 'active', max_bikes: 999, max_admin_users: 50 },
};

const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];

// The statuses an organisation may be created in. A fleet being onboarded by
// an operator is usually going straight onto a paid plan, which self-serve
// signup has no way to express.
const CREATABLE_STATUSES = ['trialing', 'active'];

const TRIAL_DAYS = 14;

function entitlementsFor(planKey = 'trial') {
  return FLEET_PLAN_ENTITLEMENTS[planKey] || FLEET_PLAN_ENTITLEMENTS.trial;
}

function isKnownPlan(planKey) {
  return Object.keys(FLEET_PLAN_ENTITLEMENTS).includes(String(planKey || '').toLowerCase());
}

async function slugifyCompanyName(value, db = pgDb) {
  const base = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `fleet-${Date.now()}`;
  let slug = base;
  let counter = 2;
  // Two fleets called "Rapid Wheels" are not an error, but two rows with the
  // same slug are — the slug is how a fleet is addressed.
  for (;;) {
    const { rows } = await db.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
    if (!rows[0]) break;
    slug = `${base}-${counter++}`;
  }
  return slug;
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/**
 * Create an organisation and its first user, in one transaction.
 *
 * Pass `password` for self-serve signup. Leave it out and the user is created
 * with an unusable random hash: they exist, they own the fleet, and they
 * cannot sign in until they have been through the reset link. That is the
 * operator-onboarding case, and it is deliberately not the same as creating
 * them with a password somebody else knows.
 */
async function createFleetOrganisation({
  companyName, fullName, email, phone = null, city = null, fleetSize = 0,
  planKey = 'trial', role = 'fleet_owner_admin', password = null, status = 'trialing',
} = {}) {
  const name = String(companyName || '').trim();
  const owner = String(fullName || '').trim();
  const mail = String(email || '').trim().toLowerCase();

  if (!name) throw fail('A company name is needed');
  if (!owner) throw fail('A contact name is needed');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw fail('A valid email address is needed');
  if (!FLEET_ROLE_VALUES.includes(role)) throw fail('That is not a fleet-owner role');
  if (!CREATABLE_STATUSES.includes(status)) throw fail('A new fleet starts either trialing or active');

  const plan = isKnownPlan(planKey) ? String(planKey).toLowerCase() : 'trial';

  const { rows: taken } = await pgDb.query(
    'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [mail]);
  if (taken[0]) throw fail('That email address already has an account', 409);

  // No password means no usable hash. Random rather than null because the
  // column is not nullable and because a predictable placeholder is a
  // password.
  const hash = password
    ? await bcrypt.hash(String(password), 10)
    : await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

  const ent = entitlementsFor(plan);
  const now = new Date();
  const trialEnds = status === 'trialing'
    ? new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
    : null;
  const slug = await slugifyCompanyName(name);

  return pgDb.withTransaction(async (tx) => {
    const { rows: orgRows } = await tx.query(
      `INSERT INTO organizations
         (name, slug, contact_email, contact_phone, city, fleet_size, plan_key, status,
          trial_started_at, trial_ends_at, max_bikes, max_admin_users)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, name, slug, status, plan_key`,
      [name, slug, mail, phone || null, city || null, Math.max(0, Number(fleetSize) || 0), plan, status,
        status === 'trialing' ? now.toISOString() : null,
        trialEnds ? trialEnds.toISOString() : null,
        ent.max_bikes, ent.max_admin_users]);
    const organization = orgRows[0];

    const { rows: userRows } = await tx.query(
      `INSERT INTO users (email, password_hash, full_name, phone, city, role, organization_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id, email, full_name, role`,
      [mail, hash, owner, phone || null, city || null, role, organization.id]);

    return {
      organization,
      user: userRows[0],
      organizationId: organization.id,
      userId: userRows[0].id,
      slug,
      // Whether this account can be signed into as it stands.
      needsPasswordSetup: !password,
    };
  });
}

module.exports = {
  FLEET_PLAN_ENTITLEMENTS, FLEET_ROLE_VALUES, CREATABLE_STATUSES, TRIAL_DAYS,
  entitlementsFor, isKnownPlan, slugifyCompanyName, createFleetOrganisation,
};
