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

// What Paystack keeps, and what we add so it does not come out of the package.
//
// The rates a customer is quoted are what the business intends to receive. A
// card payment does not deliver that: Paystack takes a percentage and a fixed
// amount, and on a R950 invoice that is most of a bike's monthly margin.
//
// So the fee is added to the invoice and the arithmetic is run backwards from
// the amount that has to land. It is not simply "add 3%": the surcharge is
// part of the consideration for the supply, so it attracts VAT itself, and
// VAT on the surcharge is money owed to SARS that the surcharge then has to
// cover as well. Grossing up the VAT-inclusive total alone leaves the
// business about half a percent short.
//
//   Charged      G = (1 + vat)(S + F)
//   Paystack     keeps rate*G + fixed
//   Must satisfy G - (rate*G + fixed) = S + vat*(S + F)
//
// which solves to F = ((1 + vat) - (1 - rate)(1 + vat))*S + fixed
//                     ---------------------------------------
//                          (1 - rate)(1 + vat) - vat
//
// CAP is the important one to get right before this goes live. Paystack caps
// its local-card fee, and above that ceiling the percentage stops applying —
// so an uncapped calculation would overcharge a large fleet badly: on a
// R75 000 invoice the uncapped fee is R2 682. Left null deliberately, because
// guessing a ceiling is worse than not applying one; set
// PAYSTACK_FEE_CAP once the real figure is confirmed with Paystack.
const PAYSTACK_FEE_RATE = Number(process.env.PAYSTACK_FEE_RATE ?? 0.03);
const PAYSTACK_FEE_FIXED = Number(process.env.PAYSTACK_FEE_FIXED ?? 2);
const PAYSTACK_FEE_CAP = process.env.PAYSTACK_FEE_CAP != null
  ? Number(process.env.PAYSTACK_FEE_CAP)
  : null;

// Whether to pass the fee on at all. On by default because that is what was
// asked for, but a switch rather than an assumption: passing card costs to a
// customer is a commercial decision, and one that has to be disclosed.
const PASS_ON_PAYSTACK_FEE = String(process.env.PASS_ON_PAYSTACK_FEE ?? 'true') !== 'false';

/**
 * The processing fee to add, exclusive of VAT, so that the business nets
 * `subtotal` once Paystack has taken its cut and SARS has taken the VAT.
 */
function processingFee(subtotal, { rate = PAYSTACK_FEE_RATE, fixed = PAYSTACK_FEE_FIXED, cap = PAYSTACK_FEE_CAP, vat = VAT_RATE } = {}) {
  if (!PASS_ON_PAYSTACK_FEE || subtotal <= 0) return 0;

  const denominator = (1 - rate) * (1 + vat) - vat;
  // A rate that high means the processor keeps more than the margin and no
  // surcharge can recover it. Better to charge nothing extra than to emit a
  // negative or absurd fee.
  if (denominator <= 0) return 0;

  const uncapped = (((1 + vat) - (1 - rate) * (1 + vat)) * subtotal + fixed) / denominator;

  // Above the ceiling Paystack stops taking a percentage, and the fee needed
  // to cover a flat cap is exactly the cap.
  const fee = cap != null && rate * (1 + vat) * (subtotal + uncapped) + fixed > cap
    ? cap
    : uncapped;

  return Math.round(fee * 100) / 100;
}

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
  // The card-processing fee, added so the package amount is what actually
  // lands. It is exclusive of VAT and sits beside the subtotal, because it is
  // part of the supply and is taxed like it.
  const processing_fee = processingFee(subtotal);
  const invoiced = Math.round((subtotal + processing_fee) * 100) / 100;
  const vat = Math.round(invoiced * VAT_RATE * 100) / 100;
  const total = Math.round((invoiced + vat) * 100) / 100;

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
    // What the fee is for, so an invoice can say it rather than a customer
    // finding an unexplained number on their statement.
    processing_fee,
    processing_fee_label: 'Card processing',
    invoiced_ex_vat: invoiced,
    vat,
    vat_rate: VAT_RATE,
    total,
    // What the business is left with once Paystack and SARS have taken
    // theirs. Equal to the subtotal when the fee is being passed on, which is
    // the whole point, and worth returning so a test and an operator can both
    // check it rather than take it on trust.
    net_after_fees: Math.round((total - (PAYSTACK_FEE_RATE * total + PAYSTACK_FEE_FIXED) - vat) * 100) / 100,
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
  processingFee, PAYSTACK_FEE_RATE, PAYSTACK_FEE_FIXED, PAYSTACK_FEE_CAP, PASS_ON_PAYSTACK_FEE,
  TIERS, LEGACY_TIER_KEYS, MINIMUM_BILLABLE_BIKES, VAT_RATE, ANNUAL_MONTHS_CHARGED, NON_BILLABLE_BIKE_STATUSES,
  tier, allTiers, quote, billableBikes, quoteForOrganization,
};
