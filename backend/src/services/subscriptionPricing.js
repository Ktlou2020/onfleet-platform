'use strict';

const pgDb = require('../pgDb');

// What a fleet owes us each month.
//
// Priced per bike, not per band, because a fleet that doubles its bikes
// doubles what the platform does for it. A plan with a fixed amount cannot
// express that, which is why this is calculated and charged rather than
// handed to Paystack as a subscription plan.
//
// Every number a customer could dispute is derived here and written onto the
// invoice: the rate, the count, the bikes that were counted and the ones that
// were not. An invoice that only says "R15 160" is an argument waiting to
// happen.

const TIERS = {
  basic: {
    key: 'basic',
    name: 'Basic',
    per_bike_monthly: 95,
    includes: 'Live map and trip history, geofences and no-go zones, movement and tamper alerts, the engine immobiliser, theft cases and the control-room view, battery and device health',
  },
  workshop: {
    key: 'workshop',
    name: 'Workshop',
    per_bike_monthly: 195,
    includes: 'Everything in Basic, plus job cards, service schedules driven by real odometer readings, the dealer parts catalogue and automated ordering, driver behaviour',
  },
  fleet: {
    key: 'fleet',
    name: 'Fleet',
    per_bike_monthly: 295,
    includes: 'Everything in Workshop, plus rider agreements, weekly payment schedules, arrears and collections, payment links, the rider\'s own app',
  },
  complete: {
    key: 'complete',
    name: 'Complete',
    per_bike_monthly: 375,
    includes: 'Everything in Fleet, plus API access and webhooks, alert escalation rules, a named account manager, custom reports and exports',
  },
};

// The three tiers sold before the ladder was rebuilt around a R95 entry
// point. Nothing is on them — but this module is the same code OnFleet runs,
// and quote() throws on a plan it does not recognise, so a single stale
// subscription_tier anywhere would fail a billing run rather than degrade.
// Mapped to where each one's customer belongs rather than to the nearest
// price: track was tracking and the immobiliser, which is Basic exactly.
const LEGACY_TIER_KEYS = {
  track: 'basic',
  manage: 'fleet',
  complete: 'complete',
};

// Below this the per-bike price does not cover supporting an account at all,
// so a smaller fleet pays as though it had this many.
const MINIMUM_BILLABLE_BIKES = 10;

// Every rate above is exclusive of VAT, which is how they are quoted to a
// fleet and how they are printed on the site. What we actually collect is the
// inclusive figure, and an invoice has to carry the split or it is not a tax
// invoice a customer can claim against.
const VAT_RATE = 0.15;

// Paying for the year costs ten months rather than twelve.
const ANNUAL_MONTHS_CHARGED = 10;

// A bike we are no longer running: sold, paid off by its rider, or written
// off. Everything else is on the platform and is billed for — including a
// stolen one, which is precisely when the tracking is doing its job.
const NON_BILLABLE_BIKE_STATUSES = ['sold', 'paid_off', 'written_off'];

function tier(key) {
  const k = String(key || '').toLowerCase();
  return TIERS[k] || TIERS[LEGACY_TIER_KEYS[k]] || null;
}

function allTiers() {
  return Object.values(TIERS);
}

/**
 * The bikes a fleet is billed for, and the ones it is not — both returned,
 * because "why am I paying for 43 bikes?" deserves an answer on the invoice
 * rather than a phone call.
 */
async function billableBikes(organizationId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS n
       FROM bikes
      WHERE organization_id = $1
      GROUP BY status`, [organizationId]);

  let billable = 0;
  let excluded = 0;
  const byStatus = {};
  for (const row of rows) {
    byStatus[row.status] = row.n;
    if (NON_BILLABLE_BIKE_STATUSES.includes(row.status)) excluded += row.n;
    else billable += row.n;
  }
  return { billable, excluded, by_status: byStatus };
}

/**
 * What to charge, in rand, and every number behind it.
 *
 * `bikes` is what the fleet actually has; `charged_bikes` is what it pays for,
 * which differs only when the fleet is under the minimum. Both appear on the
 * invoice so a small fleet can see why it is not paying for six.
 */
function quote({ tierKey, bikes, cycle = 'monthly' }) {
  const plan = tier(tierKey);
  if (!plan) throw new Error(`"${tierKey}" is not a plan we sell`);
  if (!Number.isFinite(bikes) || bikes < 0) throw new Error('A bike count is needed to work out the charge');

  const chargedBikes = Math.max(bikes, MINIMUM_BILLABLE_BIKES);
  const monthly = chargedBikes * plan.per_bike_monthly;
  const monthsCharged = cycle === 'annual' ? ANNUAL_MONTHS_CHARGED : 1;
  const subtotal = monthly * monthsCharged;
  // Rounded to the cent here, once, so the three figures on the invoice add up
  // exactly. Deriving VAT again at display time is how a document ends up
  // disagreeing with itself by a cent.
  const vat = Math.round(subtotal * VAT_RATE * 100) / 100;
  const total = Math.round((subtotal + vat) * 100) / 100;

  return {
    tier: plan.key,
    tier_name: plan.name,
    per_bike_monthly: plan.per_bike_monthly,
    bikes,
    charged_bikes: chargedBikes,
    at_minimum: chargedBikes > bikes,
    minimum_bikes: MINIMUM_BILLABLE_BIKES,
    cycle,
    months_charged: monthsCharged,
    monthly_total: monthly,
    subtotal,
    vat,
    vat_rate: VAT_RATE,
    total,
    // Paystack takes the smallest unit; rand are whole here, but rounding is
    // explicit so a future rate with cents cannot silently lose one.
    amount_kobo: Math.round(total * 100),
    description: cycle === 'annual'
      ? `Pillion ${plan.name} — ${chargedBikes} bikes x R${plan.per_bike_monthly} x ${monthsCharged} months, ex VAT`
      : `Pillion ${plan.name} — ${chargedBikes} bikes x R${plan.per_bike_monthly}, ex VAT`,
  };
}

/** The live quote for a fleet: its own bike count, its own plan. */
async function quoteForOrganization(organizationId, { tierKey, cycle } = {}, db = pgDb) {
  const { rows } = await db.query(
    `SELECT subscription_tier, subscription_cycle FROM organizations WHERE id = $1`, [organizationId]);
  const org = rows[0] || {};
  const counts = await billableBikes(organizationId, db);
  const q = quote({
    tierKey: tierKey || org.subscription_tier || 'fleet',
    bikes: counts.billable,
    cycle: cycle || org.subscription_cycle || 'monthly',
  });
  return { ...q, bike_breakdown: counts };
}

module.exports = {
  TIERS, LEGACY_TIER_KEYS, MINIMUM_BILLABLE_BIKES, VAT_RATE, ANNUAL_MONTHS_CHARGED, NON_BILLABLE_BIKE_STATUSES,
  tier, allTiers, quote, billableBikes, quoteForOrganization,
};
