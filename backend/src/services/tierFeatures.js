'use strict';

// What each subscription tier actually buys.
//
// The tiers have been sold since the pricing page went up and enforced
// nowhere. `organizations.subscription_tier` was read by exactly one thing —
// the billing run, to decide what to charge — and by nothing at all to decide
// what a fleet may do. A customer on Basic at R95 a bike had the same access
// as one on Complete at R375: the workshop, agreements, collections, the API,
// all of it. There was no reason for anybody to be on anything but Basic.
//
// The mapping below is not invented. It is read off the tier descriptions in
// subscriptionPricing.js, which are the same words printed on pillion.co.za,
// because the page is the promise and the code should keep it rather than
// make a second one.

// Frozen, and not merely as tidiness. Every tier decision in the system is
// this array's index, so a caller doing TIER_ORDER.sort() — which sorts in
// place — silently reorders the ladder and rewrites who may do what. A test
// did exactly that and turned Workshop into the second-highest tier.
const TIER_ORDER = Object.freeze(['basic', 'workshop', 'fleet', 'complete']);

// Sections that are not a feature anybody buys: finding your way around,
// managing your own account, and seeing what was done to it. Charging for
// these would mean a fleet that stops paying cannot see its own bill.
//
// `wallet` belongs here for a sharper reason. It holds money the fleet has
// already collected and is owed. Gating it behind the tier that earns the
// money seems reasonable until a fleet downgrades with a balance sitting in
// it, at which point the platform is holding their money and refusing to
// discuss it. Getting paid what you are owed is not a feature.
const ALWAYS = Object.freeze(['dashboard', 'help', 'team', 'billing', 'activity', 'wallet']);

// The lowest tier that includes each section, derived from the published copy:
//
//   Basic     live map and trip history, geofences and no-go zones, movement
//             and tamper alerts, the engine immobiliser, theft cases and the
//             control-room view, battery and device health
//   Workshop  + job cards, service schedules on real odometer readings, the
//             dealer parts catalogue and automated ordering, driver behaviour
//   Fleet     + rider agreements, weekly payment schedules, arrears and
//             collections, payment links, the rider's own app
//   Complete  + API access and webhooks, alert escalation rules, a named
//             account manager, custom reports and exports
const SECTION_TIER = Object.freeze({
  bikes: 'basic',
  tracking: 'basic',
  security: 'basic',      // theft cases; the control-room view of a bike going
  hubs: 'basic',

  workshop: 'workshop',

  agreements: 'fleet',
  payments: 'fleet',
  riders: 'fleet',
  applications: 'fleet',  // onboarding a rider is the front of an agreement
  collections: 'fleet',

  api_keys: 'complete',
  reporting: 'complete',  // "custom reports and exports"
});

function rank(tier) {
  const i = TIER_ORDER.indexOf(String(tier || '').toLowerCase());
  return i === -1 ? -1 : i;
}

/**
 * The tier a fleet is actually operating on.
 *
 * A trial gets everything, because a fortnight is to decide with and a
 * customer who cannot open the workshop cannot decide whether the workshop is
 * worth paying for. The cost of that is a real downgrade at the end of the
 * trial, which is a thing to say out loud on the page rather than to dodge by
 * crippling the trial.
 *
 * An active fleet with no tier chosen falls to the entry tier. Note that
 * subscriptionPricing defaults an unset tier to 'fleet' when billing — that
 * disagreement is worth closing, and until it is, an org with no tier is
 * billed at R295 while being given R95's access.
 */
function effectiveTier(org) {
  if (!org) return 'basic';
  if (org.status === 'trialing') return 'complete';
  const tier = String(org.subscription_tier || '').toLowerCase();
  return rank(tier) === -1 ? 'basic' : tier;
}

/** Does this tier include this section? */
function tierAllows(tier, section) {
  if (ALWAYS.includes(section)) return true;
  const needed = SECTION_TIER[section];
  // A section nobody has priced is not a section anybody is locked out of.
  // Failing open here is deliberate: a new feature should reach customers and
  // then be priced, rather than silently 403 on the day it ships.
  if (!needed) return true;
  return rank(tier) >= rank(needed);
}

/** The cheapest tier that includes a section, or null if it is free to all. */
function minimumTierFor(section) {
  if (ALWAYS.includes(section)) return null;
  return SECTION_TIER[section] || null;
}

/** Every section a tier unlocks, for the frontend to draw with. */
function sectionsFor(tier) {
  const out = [...ALWAYS];
  for (const [section, needed] of Object.entries(SECTION_TIER)) {
    if (rank(tier) >= rank(needed)) out.push(section);
  }
  return out.sort();
}

module.exports = {
  TIER_ORDER, ALWAYS, SECTION_TIER,
  rank, effectiveTier, tierAllows, minimumTierFor, sectionsFor,
};
