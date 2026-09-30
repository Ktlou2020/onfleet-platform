import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader } from './helpers/testPgDb.js';

const tiers = createRequire(import.meta.url)('../src/services/tierFeatures.js');
const app = buildApp();

// What each tier actually buys.
//
// The four tiers have been sold and billed for since the pricing page went
// up, and enforced nowhere: subscription_tier was read by the billing run to
// decide what to charge and by nothing at all to decide what a fleet could
// do. Basic at R95 a bike bought the same product as Complete at R375.
//
// These tests are the difference between a price list and a product.

describe('the ladder itself', () => {
  // Frozen because a caller sorting it in place would reorder the ladder and
  // rewrite every permission that hangs off it. This is not hypothetical: the
  // test below used to do it, and Workshop briefly outranked Fleet.
  it('cannot be reordered by anybody holding it', () => {
    expect(Object.isFrozen(tiers.TIER_ORDER)).toBe(true);
    expect(() => tiers.TIER_ORDER.sort()).toThrow();
  });

  it('climbs basic, workshop, fleet, complete', () => {
    expect(tiers.TIER_ORDER).toEqual(['basic', 'workshop', 'fleet', 'complete']);
  });

  it('gives a higher tier everything a lower one has', () => {
    for (let i = 1; i < tiers.TIER_ORDER.length; i += 1) {
      const lower = tiers.sectionsFor(tiers.TIER_ORDER[i - 1]);
      const higher = tiers.sectionsFor(tiers.TIER_ORDER[i]);
      for (const section of lower) {
        expect(higher, `${tiers.TIER_ORDER[i]} lost ${section}`).toContain(section);
      }
    }
  });

  // Each step has to be worth paying for, or the page is selling nothing.
  it('adds something at every step up', () => {
    for (let i = 1; i < tiers.TIER_ORDER.length; i += 1) {
      const gained = tiers.sectionsFor(tiers.TIER_ORDER[i])
        .filter((s) => !tiers.sectionsFor(tiers.TIER_ORDER[i - 1]).includes(s));
      expect(gained.length, `${tiers.TIER_ORDER[i]} adds nothing over ${tiers.TIER_ORDER[i - 1]}`).toBeGreaterThan(0);
    }
  });

  it('matches the tiers the pricing code sells', () => {
    const pricing = createRequire(import.meta.url)('../src/services/subscriptionPricing.js');
    // Copied before sorting: TIER_ORDER is the ladder every tier check
    // ranks against, and sort() would reorder it in place.
    expect([...tiers.TIER_ORDER].sort()).toEqual(pricing.allTiers().map((t) => t.key).sort());
  });
});

describe('what a tier includes', () => {
  it('puts tracking and the immobiliser in the cheapest one', () => {
    expect(tiers.tierAllows('basic', 'tracking')).toBe(true);
    expect(tiers.tierAllows('basic', 'bikes')).toBe(true);
    expect(tiers.tierAllows('basic', 'security')).toBe(true);
  });

  it('keeps the workshop out of Basic', () => {
    expect(tiers.tierAllows('basic', 'workshop')).toBe(false);
    expect(tiers.tierAllows('workshop', 'workshop')).toBe(true);
  });

  it('keeps agreements and collections for Fleet and up', () => {
    for (const section of ['agreements', 'payments', 'collections', 'riders']) {
      expect(tiers.tierAllows('workshop', section), `${section} leaked into Workshop`).toBe(false);
      expect(tiers.tierAllows('fleet', section)).toBe(true);
    }
  });

  it('keeps the API for Complete', () => {
    expect(tiers.tierAllows('fleet', 'api_keys')).toBe(false);
    expect(tiers.tierAllows('complete', 'api_keys')).toBe(true);
  });

  // Billing and help are not features anybody buys. A fleet that has stopped
  // paying must still be able to see its own bill.
  it('never charges for the bill, the team or the way out', () => {
    for (const section of ['dashboard', 'billing', 'team', 'help', 'activity']) {
      expect(tiers.tierAllows('basic', section), `${section} was gated`).toBe(true);
    }
  });

  // A fleet that downgrades with a balance must still be able to withdraw it.
  // Holding somebody's money and refusing to discuss it because of their plan
  // is not a tier, it is a complaint.
  it('never locks a fleet out of money it has already collected', () => {
    for (const tier of tiers.TIER_ORDER) {
      expect(tiers.tierAllows(tier, 'wallet'), `wallet gated on ${tier}`).toBe(true);
    }
    expect(tiers.minimumTierFor('wallet')).toBeNull();
  });

  it('says what the cheapest tier for a section is', () => {
    expect(tiers.minimumTierFor('workshop')).toBe('workshop');
    expect(tiers.minimumTierFor('agreements')).toBe('fleet');
    expect(tiers.minimumTierFor('billing')).toBeNull();
  });
});

describe('the tier a fleet is actually on', () => {
  it('gives a trial everything, so it can be evaluated', () => {
    expect(tiers.effectiveTier({ status: 'trialing', subscription_tier: null })).toBe('complete');
  });

  it('falls to the entry tier when an active fleet has chosen none', () => {
    expect(tiers.effectiveTier({ status: 'active', subscription_tier: null })).toBe('basic');
  });

  it('ignores a tier nobody sells', () => {
    expect(tiers.effectiveTier({ status: 'active', subscription_tier: 'platinum' })).toBe('basic');
  });

  it('uses the tier they are paying for', () => {
    expect(tiers.effectiveTier({ status: 'active', subscription_tier: 'fleet' })).toBe('fleet');
  });
});

// The half that matters: the API refusing, not the menu hiding.
describe.skipIf(!process.env.DATABASE_URL)('a fleet hitting a feature it has not bought', () => {
  let org, owner;

  const setTier = (tier, status = 'active') =>
    pgDb.query('UPDATE organizations SET subscription_tier = $1, status = $2 WHERE id = $3', [tier, status, org.id]);

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels', status: 'active' });
    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });
  });

  const get = (path) => request(app).get(path).set(authHeader(owner.user));

  it('is refused, and told what it would take', async () => {
    await setTier('basic');
    const res = await get('/api/fleet/workshop/job-cards');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TIER_REQUIRED');
    expect(res.body.current_tier).toBe('basic');
    expect(res.body.required_tier).toBe('workshop');
  });

  it('and is let through once it has paid for it', async () => {
    await setTier('workshop');
    expect((await get('/api/fleet/workshop/job-cards')).status).toBe(200);
  });

  // The upgrade path, which is the thing that was doing nothing at all.
  it('gains the features the moment the tier changes', async () => {
    await setTier('basic');
    expect((await get('/api/fleet/agreements')).status).toBe(403);
    await setTier('fleet');
    expect((await get('/api/fleet/agreements')).status).toBe(200);
  });

  it('loses them again on a downgrade', async () => {
    await setTier('fleet');
    expect((await get('/api/fleet/agreements')).status).toBe(200);
    await setTier('basic');
    expect((await get('/api/fleet/agreements')).status).toBe(403);
  });

  it('keeps Basic out of everything above it', async () => {
    await setTier('basic');
    for (const path of ['/api/fleet/workshop/job-cards', '/api/fleet/agreements',
      '/api/fleet/payments', '/api/fleet/applications']) {
      const res = await get(path);
      expect(res.status, `${path} was reachable on Basic`).toBe(403);
      expect(res.body.code).toBe('TIER_REQUIRED');
    }
  });

  it('still lets Basic do what Basic is for', async () => {
    await setTier('basic');
    for (const path of ['/api/fleet/bikes', '/api/fleet/theft-cases']) {
      expect((await get(path)).status, `${path} was refused on Basic`).toBe(200);
    }
  });

  it('lets a trial see everything', async () => {
    await pgDb.query(
      `UPDATE organizations SET status='trialing', subscription_tier=NULL,
              trial_ends_at = NOW() + INTERVAL '7 days' WHERE id = $1`, [org.id]);
    expect((await get('/api/fleet/workshop/job-cards')).status).toBe(200);
    expect((await get('/api/fleet/agreements')).status).toBe(200);
  });

  // A locked feature and a wrong-role request are different failures and a
  // fleet owner needs to be able to tell them apart.
  it('tells a locked feature apart from a forbidden role', async () => {
    await setTier('complete');
    const viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: org.id });
    const res = await request(app).get('/api/fleet/workshop/job-cards').set(authHeader(viewer.user));
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe('TIER_REQUIRED');
  });
});
