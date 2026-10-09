import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader,
} from './helpers/testPgDb.js';

const legacy = createRequire(import.meta.url)('../src/services/legacySubscriptions.js');
const app = buildApp();

// Winding down the flat monthly subscriptions.
//
// Disabling one at Paystack stops the next charge and leaves the period
// already paid for alone, so cancelling now is cancelling at period end.
// Everything worth testing is around that, because there are two ways to get
// it wrong and both cost somebody money: billing a fleet twice for the
// overlap, or cancelling a fleet nothing can then charge and giving away the
// platform without noticing.
//
// Paystack is behind a seam so these assert what would be done to a real
// customer's subscription without doing it to one.

const dayOffset = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!process.env.DATABASE_URL)('retiring a flat subscription', () => {
  let superadmin, org;
  let fakePaystack;
  const PERIOD_END = dayOffset(18);

  const setOrg = (fields) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return pgDb.query(`UPDATE organizations SET ${sets} WHERE id = $1`, [org.id, ...keys.map((k) => fields[k])]);
  };

  const orgRow = async () => {
    const { rows } = await pgDb.query('SELECT * FROM organizations WHERE id = $1', [org.id]);
    return rows[0];
  };

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    org = await createPgOrg({ name: 'Kasi Couriers' });
    await setOrg({
      status: 'active', subscription_status: 'active',
      plan_key: 'medium', paystack_subscription_code: 'SUB_legacy',
      subscription_tier: 'fleet', billing_method: 'card',
      billing_authorization_encrypted: 'enc:fake-authorization',
      next_billing_date: dayOffset(2),
    });

    fakePaystack = {
      disabled: [],
      async fetch() { return { email_token: 'tok_abc', next_payment_date: `${PERIOD_END}T00:00:00.000Z` }; },
      async disable(code, token) { this.disabled.push({ code, token }); },
    };
  });

  describe('what it does to Paystack', () => {
    it('disables the subscription with the token Paystack asked for', async () => {
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect(res.ok).toBe(true);
      expect(fakePaystack.disabled).toEqual([{ code: 'SUB_legacy', token: 'tok_abc' }]);
    });

    it('reports a Paystack refusal instead of claiming success', async () => {
      const broken = {
        async fetch() { throw new Error('subscription not found'); },
        async disable() { throw new Error('should not be reached'); },
      };
      const res = await legacy.cancelOne(org.id, { client: broken, notify: false });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(502);

      // And nothing was written locally, so it can be retried.
      const after = await orgRow();
      expect(after.paystack_subscription_code, 'the local row was updated after Paystack refused').toBe('SUB_legacy');
    });
  });

  // The expensive mistake. A fleet with a card would otherwise be invoiced by
  // our run for days the flat plan had already paid for.
  describe('the handover', () => {
    it('moves our first charge to the day the paid period ends', async () => {
      await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });

      // pg hands back a `date` column as a string here and a Date elsewhere
      // depending on the driver's type parsers, so normalise rather than
      // assume either.
      const asDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

      const after = await orgRow();
      expect(asDay(after.legacy_subscription_ends_at)).toBe(PERIOD_END);
      expect(asDay(after.next_billing_date),
        'our billing run would have charged them for days the flat plan covered').toBe(PERIOD_END);
    });

    it('clears the subscription code so the fleet drops off the list', async () => {
      await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect((await orgRow()).paystack_subscription_code).toBeNull();
      expect(await legacy.list()).toHaveLength(0);
    });

    it('records when it was cancelled', async () => {
      await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect((await orgRow()).legacy_subscription_cancelled_at).toBeTruthy();
    });

    it('will not cancel the same plan twice', async () => {
      await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      await setOrg({ paystack_subscription_code: 'SUB_legacy' });
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(409);
    });
  });

  // The other expensive mistake, in the opposite direction.
  describe('a fleet nothing could charge afterwards', () => {
    it('is refused when it has no per-bike plan', async () => {
      await setOrg({ subscription_tier: null });
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('NOT_READY');
      expect(res.error).toContain('No per-bike plan');
      expect(fakePaystack.disabled, 'Paystack was called for a fleet that would then pay nothing').toHaveLength(0);
    });

    it('is refused when it has no card and is not on EFT', async () => {
      await setOrg({ billing_authorization_encrypted: null, billing_method: 'card' });
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('No card on file');
    });

    it('is allowed on EFT, where no card is expected', async () => {
      await setOrg({ billing_authorization_encrypted: null, billing_method: 'eft' });
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, notify: false });
      expect(res.ok).toBe(true);
    });

    // Giving somebody a free month is a decision, not an accident.
    it('can be forced, and says that it was', async () => {
      await setOrg({ subscription_tier: null });
      const res = await legacy.cancelOne(org.id, { client: fakePaystack, force: true, notify: false });
      expect(res.ok).toBe(true);
      expect(res.forced).toBe(true);
    });
  });

  describe('the list an operator reads first', () => {
    it('says which fleets would be left paying nothing, and why', async () => {
      await setOrg({ subscription_tier: null });
      const [fleet] = await legacy.list();
      expect(fleet.ready).toBe(false);
      expect(fleet.blocker).toContain('No per-bike plan');
    });

    it('counts them for the operator', async () => {
      await setOrg({ subscription_tier: null });
      const res = await request(app).get('/api/admin/legacy-subscriptions').set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.not_ready).toBe(1);
    });

    it('leaves out a fleet that never had one', async () => {
      await createPgOrg({ name: 'Never Subscribed' });
      expect((await legacy.list()).map((f) => f.name)).toEqual(['Kasi Couriers']);
    });
  });

  describe('cancelling several', () => {
    it('keeps going when one fails, and reports each', async () => {
      const second = await createPgOrg({ name: 'Rapid Wheels' });
      await pgDb.query(
        `UPDATE organizations SET plan_key='small', paystack_subscription_code='SUB_two',
           subscription_tier=NULL, status='active' WHERE id = $1`, [second.id]);

      const outcome = await legacy.cancelMany([org.id, second.id], { client: fakePaystack, notify: false });
      expect(outcome.cancelled).toBe(1);
      expect(outcome.failed).toBe(1);
      expect(outcome.results.find((r) => r.id === second.id).code).toBe('NOT_READY');
      // The one that could be cancelled, was.
      expect(fakePaystack.disabled).toHaveLength(1);
    });
  });

  describe('the admin endpoints', () => {
    it('refuses a bulk cancel that names nobody', async () => {
      const res = await request(app).post('/api/admin/legacy-subscriptions/cancel')
        .set(authHeader(superadmin.user)).send({ organization_ids: [] });
      expect(res.status).toBe(400);
    });

    it('is closed to an ordinary admin', async () => {
      const admin = await createPgUser({ role: 'admin' });
      const res = await request(app).get('/api/admin/legacy-subscriptions').set(authHeader(admin.user));
      expect(res.status).toBe(403);
    });
  });

  describe('what the customer is told', () => {
    it('says nothing changes until the date they have paid to', () => {
      const body = legacy.noticeBody({ org: { name: 'Kasi Couriers' }, endsAt: '2026-11-12' });
      expect(body).toContain('12 November 2026');
      expect(body).toContain('Nothing changes before');
      expect(body).toContain('per-bike');
    });

    it('still reads sensibly when Paystack gave no date', () => {
      const body = legacy.noticeBody({ org: { name: 'Kasi Couriers' }, endsAt: null });
      expect(body).toContain('the end of the current period');
      expect(body).not.toContain('null');
    });
  });
});
