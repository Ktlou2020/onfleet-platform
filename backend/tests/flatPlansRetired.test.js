import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// Retiring the flat monthly plans.
//
// They were a second billing system living beside the per-bike one. The
// portal's Billing page sold Starter/Growth/Professional into
// organizations.plan_key, charged by a Paystack recurring subscription;
// feature gating, our billing run, invoices, dunning, EFT and suspension all
// read subscription_tier instead. effectiveTier does not recognise a flat key
// and falls through to 'basic', so a customer paying R750 a month was served
// the cheapest feature set we have.
//
// Nothing may start one now. The subscriptions already sold keep running
// until somebody cancels them at Paystack, so the ways out stay.

describe.skipIf(!process.env.DATABASE_URL)('the retired flat plans', () => {
  let org, owner;

  const setOrg = (fields) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return pgDb.query(`UPDATE organizations SET ${sets} WHERE id = $1`, [org.id, ...keys.map((k) => fields[k])]);
  };

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg({ name: 'Kasi Couriers' });
    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });
    await setOrg({
      status: 'active', subscription_status: 'active',
      subscription_tier: 'fleet', subscription_cycle: 'monthly',
    });
  });

  describe('nothing can start one', () => {
    // 410 rather than a deleted route: a stale tab or a bookmarked checkout
    // gets a sentence saying where billing went, not a 404 that reads as the
    // platform being broken.
    it.each([
      ['subscribe', 'post', '/api/fleet/billing/subscribe'],
      ['verify a checkout', 'get', '/api/fleet/billing/verify'],
    ])('cannot %s', async (_label, method, path) => {
      const res = await request(app)[method](path)
        .set(authHeader(owner.user)).send({ plan_key: 'medium' });
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('FLAT_PLANS_RETIRED');
      expect(res.body.moved_to).toBe('/fleet/app/subscription');
    });

    // An API that still hands out a retired catalogue is how it gets
    // rendered again by whoever builds the next billing screen.
    it('and billing status no longer advertises the catalogue', async () => {
      const res = await request(app).get('/api/fleet/billing/status').set(authHeader(owner.user));
      expect(res.status).toBe(200);
      expect(res.body.plans, 'the retired plan catalogue is still being served').toBeUndefined();
      expect(res.body.organization.suggested_tier).toBeUndefined();
    });
  });

  describe('a plan somebody already bought', () => {
    it('is surfaced so they know it is still charging them', async () => {
      await setOrg({ plan_key: 'medium', paystack_subscription_code: 'SUB_legacy' });

      const res = await request(app).get('/api/fleet/subscription').set(authHeader(owner.user));
      expect(res.status).toBe(200);
      expect(res.body.legacy_subscription).toMatchObject({ plan_key: 'medium', name: 'Growth', monthly_price: 750 });
    });

    it('and is not invented for a fleet that never had one', async () => {
      await setOrg({ plan_key: 'small', paystack_subscription_code: null });
      const res = await request(app).get('/api/fleet/subscription').set(authHeader(owner.user));
      expect(res.body.legacy_subscription).toBeNull();
    });

    it('can still be cancelled', async () => {
      await setOrg({ plan_key: 'medium', paystack_subscription_code: 'SUB_legacy' });
      const res = await request(app).post('/api/fleet/billing/cancel').set(authHeader(owner.user));
      // Paystack is not configured in tests, so the call to them fails — what
      // matters here is that the route still exists and is not 410.
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(410);
    });
  });

  // The dead end this replaced: the paywall offered plans, loading them
  // answered 402, the shell swallowed the error and rendered an empty list,
  // and a suspended customer had no way to pay at all.
  describe('a blocked account can still pay its way out', () => {
    beforeEach(() => setOrg({ status: 'suspended', subscription_status: 'past_due' }));

    it.each([
      ['read its subscription', '/api/fleet/subscription'],
      ['read its billing status', '/api/fleet/billing/status'],
    ])('can %s', async (_label, path) => {
      const res = await request(app).get(path).set(authHeader(owner.user));
      expect(res.status, 'the only page that can unblock the account was paywalled').toBe(200);
    });

    // The paywall is still a paywall for everything else.
    it.each([
      ['/api/fleet/portal-data'],
      ['/api/fleet/bikes'],
      ['/api/fleet/agreements'],
    ])('but still cannot reach %s', async (path) => {
      const res = await request(app).get(path).set(authHeader(owner.user));
      expect(res.status).toBe(402);
    });

    it('and a cancelled account can reach billing too', async () => {
      await setOrg({ status: 'cancelled' });
      const res = await request(app).get('/api/fleet/subscription').set(authHeader(owner.user));
      expect(res.status).toBe(200);
    });
  });
});
