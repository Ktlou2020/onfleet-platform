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
  track: {
    key: 'track',
    name: 'Track',
    per_bike_monthly: 199,
    includes: 'Live map and trip history, geofences and no-go zones, engine immobiliser, the full alert set, theft cases, control-room view',
  },
  manage: {
    key: 'manage',
    name: 'Manage',
    per_bike_monthly: 299,
    includes: 'Everything in Track, plus rider agreements, weekly payment schedules, arrears and collections, payment links, the rider\'s own app',
  },
  complete: {
    key: 'complete',
    name: 'Complete',
    per_bike_monthly: 379,
    includes: 'Everything in Manage, plus job cards, service schedules driven by real odometer readings, the dealer parts catalogue and automated ordering',
  },
};

// Below this the per-bike price does not cover supporting an account at all,
// so a smaller fleet pays as though it had this many.
const MINIMUM_BILLABLE_BIKES = 10;

// Paying for the year costs ten months rather than twelve.
const ANNUAL_MONTHS_CHARGED = 10;

// A bike we are no longer running: sold, paid off by its rider, or written
// off. Everything else is on the platform and is billed for — including a
// stolen one, which is precisely when the tracking is doing its job.
const NON_BILLABLE_BIKE_STATUSES = ['sold', 'paid_off', 'written_off'];

function tier(key) {
  return TIERS[String(key || '').toLowerCase()] || null;
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
  const total = monthly * monthsCharged;

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
    total,
    // Paystack takes the smallest unit; rand are whole here, but rounding is
    // explicit so a future rate with cents cannot silently lose one.
    amount_kobo: Math.round(total * 100),
    description: cycle === 'annual'
      ? `Pillion ${plan.name} — ${chargedBikes} bikes x R${plan.per_bike_monthly} x ${monthsCharged} months`
      : `Pillion ${plan.name} — ${chargedBikes} bikes x R${plan.per_bike_monthly}`,
  };
}

/** The live quote for a fleet: its own bike count, its own plan. */
async function quoteForOrganization(organizationId, { tierKey, cycle } = {}, db = pgDb) {
  const { rows } = await db.query(
    `SELECT subscription_tier, subscription_cycle FROM organizations WHERE id = $1`, [organizationId]);
  const org = rows[0] || {};
  const counts = await billableBikes(organizationId, db);
  const q = quote({
    tierKey: tierKey || org.subscription_tier || 'manage',
    bikes: counts.billable,
    cycle: cycle || org.subscription_cycle || 'monthly',
  });
  return { ...q, bike_breakdown: counts };
}

module.exports = {
  TIERS, MINIMUM_BILLABLE_BIKES, ANNUAL_MONTHS_CHARGED, NON_BILLABLE_BIKE_STATUSES,
  tier, allTiers, quote, billableBikes, quoteForOrganization,
};
