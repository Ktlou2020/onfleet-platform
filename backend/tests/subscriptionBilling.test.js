import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgOrg, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const pricing = load('../src/services/subscriptionPricing.js');
const billing = load('../src/services/subscriptionBilling.js');
const axios = load('axios');

// Pillion is priced per bike, so the amount changes every month and cannot be
// a fixed Paystack plan. The platform works it out and charges a saved card.
//
// Two things must hold, and everything below is one or the other: charge the
// right amount, and never charge twice for the same month.
describe('what a fleet is charged', () => {
  it('multiplies the bikes it has by the rate for its plan', () => {
    expect(pricing.quote({ tierKey: 'complete', bikes: 40 })).toMatchObject({
      per_bike_monthly: 379, charged_bikes: 40, total: 15160,
    });
    expect(pricing.quote({ tierKey: 'track', bikes: 40 }).total).toBe(7960);
    expect(pricing.quote({ tierKey: 'manage', bikes: 20 }).total).toBe(5980);
  });

  // The figure quoted in the proposal. If this ever changes, it changed by
  // somebody's decision rather than by accident.
  it('charges a 40-bike Complete fleet R15 160, as quoted', () => {
    expect(pricing.quote({ tierKey: 'complete', bikes: 40 }).total).toBe(15160);
  });

  it('bills a small fleet at the ten-bike minimum, and says so', () => {
    const q = pricing.quote({ tierKey: 'complete', bikes: 6 });
    expect(q).toMatchObject({ bikes: 6, charged_bikes: 10, at_minimum: true, total: 3790 });
  });

  it('does not pretend a fleet at the minimum is larger than it is', () => {
    expect(pricing.quote({ tierKey: 'complete', bikes: 6 }).bikes).toBe(6);
  });

  it('charges ten months for a year, not twelve', () => {
    const annual = pricing.quote({ tierKey: 'complete', bikes: 40, cycle: 'annual' });
    expect(annual.months_charged).toBe(10);
    expect(annual.total).toBe(151600);
  });

  it('sends Paystack the amount in cents, not rand', () => {
    expect(pricing.quote({ tierKey: 'complete', bikes: 40 }).amount_kobo).toBe(1516000);
  });

  it('refuses a plan we do not sell', () => {
    expect(() => pricing.quote({ tierKey: 'empire', bikes: 10 })).toThrow(/not a plan we sell/);
    expect(() => pricing.quote({ tierKey: '', bikes: 10 })).toThrow();
  });

  it('spells out what the charge is for', () => {
    expect(pricing.quote({ tierKey: 'complete', bikes: 40 }).description)
      .toBe('Pillion Complete — 40 bikes x R379');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('which bikes a fleet pays for', () => {
  let org;

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg({ name: 'Blue Sky Deliveries' });
  });

  const addBikes = async (status, n) => {
    for (let i = 0; i < n; i += 1) await createPgBike({ organization_id: org.id, status });
  };

  it('counts the bikes it is running', async () => {
    await addBikes('active', 12);
    await addBikes('ready_to_go', 3);
    expect((await pricing.billableBikes(org.id)).billable).toBe(15);
  });

  // Billing a rider's own bike would be charging for something we no longer
  // run, and is the kind of error a customer finds before we do.
  it('does not count a bike that has been sold, paid off or written off', async () => {
    await addBikes('active', 10);
    await addBikes('sold', 2);
    await addBikes('paid_off', 5);
    await addBikes('written_off', 1);
    const counts = await pricing.billableBikes(org.id);
    expect(counts).toMatchObject({ billable: 10, excluded: 8 });
  });

  // A stolen bike is exactly when the tracking earns its money.
  it('still counts a stolen bike', async () => {
    await addBikes('active', 5);
    await addBikes('stolen', 2);
    expect((await pricing.billableBikes(org.id)).billable).toBe(7);
  });

  it('shows the breakdown, so the invoice can answer for itself', async () => {
    await addBikes('active', 4);
    await addBikes('paid_off', 2);
    const counts = await pricing.billableBikes(org.id);
    expect(counts.by_status).toMatchObject({ active: 4, paid_off: 2 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('charging the card on file', () => {
  let org;
  let postSpy;

  const KEY = Buffer.alloc(32, 5).toString('hex');
  const AUTH = { authorization_code: 'AUTH_abc123xyz', last4: '4081', brand: 'visa', exp_month: 12, exp_year: 2030, reusable: true };

  beforeEach(async () => {
    await resetAllPgTables();
    process.env.CREDENTIAL_ENCRYPTION_KEY = KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_platform_0000000';
    org = await createPgOrg({ name: 'Blue Sky Deliveries' });
    for (let i = 0; i < 40; i += 1) await createPgBike({ organization_id: org.id, status: 'active' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', subscription_cycle='monthly', subscription_status='active' WHERE id=$1`,
      [org.id]);
    await billing.rememberAuthorization({ organizationId: org.id, authorization: AUTH, email: 'ops@bluesky.co.za' });
  });

  afterEach(() => { postSpy?.mockRestore(); });

  const paystackReturns = (data) => {
    postSpy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { status: true, data } });
    return postSpy;
  };

  it('charges the amount the bike count says, in cents', async () => {
    paystackReturns({ status: 'success', reference: 'ref_1' });
    const result = await billing.chargeOrganization(org.id);
    expect(result.charged).toBe(true);
    expect(result.amount).toBe(15160);
    expect(postSpy.mock.calls[0][1]).toMatchObject({ amount: 1516000, currency: 'ZAR' });
  });

  it('sends the saved authorisation, not a card number', async () => {
    paystackReturns({ status: 'success', reference: 'ref_1' });
    await billing.chargeOrganization(org.id);
    expect(postSpy.mock.calls[0][1].authorization_code).toBe('AUTH_abc123xyz');
  });

  // The one that matters most: a scheduler that runs twice, a retry after a
  // timeout, a webhook arriving late — all must end with one invoice.
  it('does not charge twice for the same month', async () => {
    paystackReturns({ status: 'success', reference: 'ref_1' });
    const first = await billing.chargeOrganization(org.id);
    const second = await billing.chargeOrganization(org.id);

    expect(first.charged).toBe(true);
    expect(second).toMatchObject({ skipped: 'already invoiced for this period' });
    expect(postSpy).toHaveBeenCalledTimes(1);

    const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM subscription_invoices WHERE organization_id=$1', [org.id]);
    expect(rows[0].n).toBe(1);
  });

  it('records the rate and the counts on the invoice', async () => {
    paystackReturns({ status: 'success', reference: 'ref_1' });
    await billing.chargeOrganization(org.id);
    const { rows } = await pgDb.query('SELECT * FROM subscription_invoices WHERE organization_id=$1', [org.id]);
    expect(rows[0]).toMatchObject({
      tier: 'complete', bikes: 40, charged_bikes: 40, status: 'paid',
    });
    expect(Number(rows[0].per_bike_monthly)).toBe(379);
    expect(Number(rows[0].amount)).toBe(15160);
  });

  it('marks a declined card as failed and counts the failure', async () => {
    paystackReturns({ status: 'failed', gateway_response: 'Insufficient funds', reference: 'ref_2' });
    const result = await billing.chargeOrganization(org.id);
    expect(result).toMatchObject({ charged: false, reason: 'Insufficient funds' });

    const { rows } = await pgDb.query(
      `SELECT i.status, i.failure_reason, o.billing_failure_count
         FROM subscription_invoices i JOIN organizations o ON o.id = i.organization_id
        WHERE i.organization_id = $1`, [org.id]);
    expect(rows[0]).toMatchObject({ status: 'failed', failure_reason: 'Insufficient funds', billing_failure_count: 1 });
  });

  // A failed charge must not block the month: the fleet fixes its card and
  // the next attempt has to be able to claim the period again.
  it('lets a failed period be retried', async () => {
    paystackReturns({ status: 'failed', gateway_response: 'Declined', reference: 'ref_3' });
    await billing.chargeOrganization(org.id);
    postSpy.mockRestore();

    paystackReturns({ status: 'success', reference: 'ref_4' });
    const retry = await billing.chargeOrganization(org.id);
    expect(retry.charged).toBe(true);
  });

  describe('when it must not charge at all', () => {
    const reasons = {
      'no card on file': `UPDATE organizations SET billing_authorization_encrypted=NULL WHERE id=$1`,
      'no plan chosen': `UPDATE organizations SET subscription_tier=NULL WHERE id=$1`,
      'subscription cancelled': `UPDATE organizations SET subscription_status='cancelled' WHERE id=$1`,
    };

    for (const [reason, sql] of Object.entries(reasons)) {
      it(`skips with "${reason}"`, async () => {
        paystackReturns({ status: 'success', reference: 'x' });
        await pgDb.query(sql, [org.id]);
        expect(await billing.chargeOrganization(org.id)).toMatchObject({ skipped: reason });
        expect(postSpy).not.toHaveBeenCalled();
      });
    }

    // Falling back to anything here would be charging a card we cannot read.
    it('refuses when the saved card cannot be decrypted', async () => {
      paystackReturns({ status: 'success', reference: 'x' });
      process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('hex');
      expect(await billing.chargeOrganization(org.id)).toMatchObject({ skipped: expect.stringMatching(/cannot be read/) });
      expect(postSpy).not.toHaveBeenCalled();
    });
  });

  describe('saving the card', () => {
    it('keeps the authorisation encrypted, and the last four in the clear', async () => {
      const { rows } = await pgDb.query(
        'SELECT billing_authorization_encrypted, billing_card_last4, billing_card_brand FROM organizations WHERE id=$1', [org.id]);
      expect(rows[0].billing_authorization_encrypted).not.toContain('AUTH_');
      expect(rows[0]).toMatchObject({ billing_card_last4: '4081', billing_card_brand: 'visa' });
    });

    // Storing one that cannot be reused would read as "card on file" and fail
    // every month afterwards.
    it('refuses a card Paystack says cannot be charged again', async () => {
      await expect(billing.rememberAuthorization({
        organizationId: org.id,
        authorization: { ...AUTH, reusable: false },
      })).rejects.toThrow(/cannot be saved/i);
    });
  });

  describe('the monthly run', () => {
    it('picks up a fleet that is due and leaves one that is not', async () => {
      const notDue = await createPgOrg({ name: 'Later Fleet', slug: 'later-fleet' });
      await pgDb.query(
        `UPDATE organizations SET subscription_tier='track', subscription_status='active',
                billing_authorization_encrypted='x', next_billing_date = CURRENT_DATE + 20 WHERE id=$1`, [notDue.id]);

      const due = await billing.organizationsDue();
      expect(due).toContain(org.id);
      expect(due).not.toContain(notDue.id);
    });

    it('carries on after one fleet fails', async () => {
      const other = await createPgOrg({ name: 'Other Fleet', slug: 'other-fleet' });
      await createPgBike({ organization_id: other.id, status: 'active' });
      await pgDb.query(
        `UPDATE organizations SET subscription_tier='track', subscription_status='active' WHERE id=$1`, [other.id]);
      await billing.rememberAuthorization({ organizationId: other.id, authorization: AUTH });

      let call = 0;
      postSpy = vi.spyOn(axios, 'post').mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new Error('network went away');
        return { data: { status: true, data: { status: 'success', reference: 'ref_ok' } } };
      });

      const results = await billing.runBillingRun();
      expect(results).toHaveLength(2);
      expect(results.filter((r) => r.charged)).toHaveLength(1);
    });
  });
});
