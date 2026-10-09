import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { createRequire } from 'node:module';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader,
} from './helpers/testPgDb.js';

const onboarding = createRequire(import.meta.url)('../src/services/fleetOnboarding.js');

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

  // Changing a customer's plan from the operator's side.
  //
  // This set plan_key, which decides nothing. An operator moving a customer
  // to "Medium" changed a label and left them on the Basic feature set — the
  // same disconnect, from the other end of the business.
  describe('an operator changing the plan', () => {
    let superadmin;
    beforeEach(async () => {
      superadmin = await createPgUser({ role: 'superadmin' });
      await setOrg({ subscription_tier: 'basic', plan_key: 'medium' });
    });

    const changePlan = (body) => request(app).post(`/api/admin/organizations/${org.id}/plan`)
      .set(authHeader(superadmin.user)).send(body);

    it('changes what the fleet can actually reach', async () => {
      const before = await request(app).get('/api/fleet/agreements').set(authHeader(owner.user));
      expect(before.status, 'a basic fleet could already see agreements').toBe(403);

      const res = await changePlan({ subscription_tier: 'fleet', status: 'active', max_admin_users: 10 });
      expect(res.status).toBe(200);

      const after = await request(app).get('/api/fleet/agreements').set(authHeader(owner.user));
      expect(after.status, 'the plan changed and the fleet still could not see agreements').toBe(200);
    });

    it('refuses a retired flat plan key', async () => {
      const res = await changePlan({ subscription_tier: 'medium' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('basic, workshop, fleet, complete');
    });

    // plan_key still ties a live Paystack subscription to this row.
    it('leaves plan_key alone', async () => {
      await changePlan({ subscription_tier: 'complete', status: 'active' });
      const { rows } = await pgDb.query('SELECT plan_key, subscription_tier FROM organizations WHERE id = $1', [org.id]);
      expect(rows[0].plan_key, 'a live legacy subscription was detached from its row').toBe('medium');
      expect(rows[0].subscription_tier).toBe('complete');
    });

    it('keeps the seat limit, which is the one limit that bites', async () => {
      const res = await changePlan({ subscription_tier: 'fleet', max_admin_users: 4 });
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query('SELECT max_admin_users FROM organizations WHERE id = $1', [org.id]);
      expect(rows[0].max_admin_users).toBe(4);
    });

    it('records the tier it moved between', async () => {
      await changePlan({ subscription_tier: 'workshop' });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'organization.plan_changed' ORDER BY id DESC LIMIT 1`);
      const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(meta).toMatchObject({ from_tier: 'basic', to_tier: 'workshop' });
    });
  });

  // Where the whole problem started: a fleet onboarded by an operator got a
  // plan_key and no tier, so it was locked out of the product it had just
  // been sold from the moment the account existed.
  describe('onboarding a fleet', () => {
    it('gives a paid plan a tier, not just a label', async () => {
      const created = await onboarding.createFleetOrganisation({
        companyName: 'Tier At Birth', fullName: 'A Owner',
        email: `tier-${Date.now()}@example.test`, planKey: 'medium', status: 'active',
      });
      const { rows } = await pgDb.query(
        'SELECT plan_key, subscription_tier FROM organizations WHERE id = $1', [created.organizationId]);
      expect(rows[0].subscription_tier, 'a fleet was onboarded onto no tier and born locked out').toBe('fleet');
    });

    it('and the largest plan gets the top tier', async () => {
      const created = await onboarding.createFleetOrganisation({
        companyName: 'Big Co', fullName: 'B Owner',
        email: `big-${Date.now()}@example.test`, planKey: 'enterprise', status: 'active',
      });
      const { rows } = await pgDb.query('SELECT subscription_tier FROM organizations WHERE id = $1', [created.organizationId]);
      expect(rows[0].subscription_tier).toBe('complete');
    });

    // effectiveTier already gives a trialing account everything; writing a
    // tier here would silently keep it after the trial ended.
    it('leaves a trial without one', async () => {
      const created = await onboarding.createFleetOrganisation({
        companyName: 'Trial Co', fullName: 'C Owner',
        email: `trial-${Date.now()}@example.test`, planKey: 'trial', status: 'trialing',
      });
      const { rows } = await pgDb.query('SELECT subscription_tier, status FROM organizations WHERE id = $1', [created.organizationId]);
      expect(rows[0].status).toBe('trialing');
      expect(rows[0].subscription_tier).toBeNull();
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
