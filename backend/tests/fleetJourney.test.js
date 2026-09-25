import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const pricing = load('../src/services/subscriptionPricing.js');
const billing = load('../src/services/subscriptionBilling.js');
const axios = load('axios');

const app = buildApp();

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('hex');
const CARD = { authorization_code: 'AUTH_journey1', last4: '4081', brand: 'visa', exp_month: 12, exp_year: 2030, reusable: true };
// Paystack's charge endpoint answers {status, data}; the shape matters because
// billing reads data.data.status to decide whether the money moved.
const paystackSays = (data) => vi.spyOn(axios, 'post').mockResolvedValue({ data: { status: true, data } });

// The journey a dealer's first customer takes, end to end.
//
// Pillion has never had a customer, so this path has never run: a fleet owner
// signs up, gets a trial, puts bikes on, picks a plan, is invoiced and is
// charged. Every step of it changed the day the tiers were rebuilt around a
// R95 entry point and VAT was added to billing, and the one thing you cannot
// apologise your way out of is taking a dealer's first customer's money
// incorrectly.
//
// Written as one ordered run rather than independent cases, because that is
// what is actually unproven — each step working alone says nothing about the
// hand-off between them.

const COMPANY = 'Swift Couriers';
const OWNER = { full_name: 'Nomsa Moyo', email: 'ops@swiftcouriers.test', password: 'a-good-password' };

describe.skipIf(!process.env.DATABASE_URL)('a fleet owner from signup to first payment', () => {
  let token;
  let orgId;

  beforeEach(async () => {
    await resetAllPgTables();
    vi.restoreAllMocks();
    process.env.CREDENTIAL_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_journey_0000000';
  });

  // What the fleet owner does at the end of the trial: picks a tier and leaves
  // a card. The card is stored the way the platform stores it, encrypted,
  // because a token it cannot decrypt is skipped rather than charged.
  async function chooseTierAndLeaveCard(tierKey) {
    await pgDb.query(
      `UPDATE organizations SET subscription_tier=$2, subscription_cycle='monthly',
              subscription_status='active' WHERE id=$1`, [orgId, tierKey]);
    await billing.rememberAuthorization({ organizationId: orgId, authorization: CARD, email: OWNER.email });
  }

  async function signUp() {
    const res = await request(app).post('/api/auth/fleet/signup').send({
      company_name: COMPANY, ...OWNER, phone: '0820000000', city: 'Johannesburg', fleet_size: 20,
    });
    expect(res.status).toBe(200);
    token = res.body.token;
    const { rows } = await pgDb.query('SELECT id, status, trial_ends_at FROM organizations WHERE name = $1', [COMPANY]);
    orgId = rows[0].id;
    return rows[0];
  }

  async function addBikes(n) {
    for (let i = 0; i < n; i++) {
      await pgDb.query(
        `INSERT INTO bikes (vin, registration, make, model, rental_weekly, total_weeks, status, organization_id)
         VALUES ($1,$2,'Hero','Eco 150',850,78,'active',$3)`,
        [`VINJOURNEY${i}`, `JNY${i}GP`, orgId]);
    }
  }

  it('is signed up onto a fourteen-day trial, with a token to work with', async () => {
    const org = await signUp();
    expect(org.status).toBe('trialing');
    const daysLeft = Math.round((new Date(org.trial_ends_at) - Date.now()) / 86400000);
    expect(daysLeft).toBe(14);
    expect(token).toBeTruthy();
  });

  it('is quoted the entry tier correctly once bikes are on', async () => {
    await signUp();
    await addBikes(20);
    const q = await pricing.quoteForOrganization(orgId, { tierKey: 'basic' });
    expect(q.bikes).toBe(20);
    expect(q.at_minimum).toBe(false);
    expect(q.subtotal).toBe(1900);
    expect(q.vat).toBe(285);
    expect(q.total).toBe(2185);
  });

  // The dealer deck sells a ten-bike minimum. A fleet under it pays as though
  // it had ten, and the quote has to say so rather than silently inflating.
  it('is held at the minimum when the fleet is smaller than ten', async () => {
    await signUp();
    await addBikes(6);
    const q = await pricing.quoteForOrganization(orgId, { tierKey: 'basic' });
    expect(q).toMatchObject({ bikes: 6, charged_bikes: 10, at_minimum: true, minimum_bikes: 10 });
    expect(q.subtotal).toBe(950);
  });

  it('is charged the VAT-inclusive amount, and the invoice carries the split', async () => {
    await signUp();
    await addBikes(20);
    await chooseTierAndLeaveCard('basic');

    paystackSays({ status: 'success', reference: 'ref_journey' });
    const result = await billing.chargeOrganization(orgId);

    expect(result.charged).toBe(true);
    expect(result.amount).toBe(2185);

    const { rows } = await pgDb.query(
      `SELECT subtotal, vat, amount, status, tier FROM subscription_invoices WHERE organization_id = $1`, [orgId]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].subtotal)).toBe(1900);
    expect(Number(rows[0].vat)).toBe(285);
    expect(Number(rows[0].amount)).toBe(2185);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].tier).toBe('basic');
  });

  // Paystack takes cents. Sending it the ex-VAT figure is the fault this
  // journey exists to catch, because nothing downstream would notice.
  it('sends Paystack the inclusive figure in cents, not the quoted rate', async () => {
    await signUp();
    await addBikes(20);
    await chooseTierAndLeaveCard('basic');

    const post = paystackSays({ status: 'success', reference: 'ref_journey' });
    await billing.chargeOrganization(orgId);

    expect(post.mock.calls[0][1]).toMatchObject({ amount: 218500, currency: 'ZAR' });
  });

  it('is not billed twice in the same month', async () => {
    await signUp();
    await addBikes(20);
    await chooseTierAndLeaveCard('basic');

    paystackSays({ status: 'success', reference: 'ref_journey' });
    await billing.chargeOrganization(orgId);
    await billing.chargeOrganization(orgId);

    const { rows } = await pgDb.query(
      `SELECT COUNT(*)::int AS n FROM subscription_invoices WHERE organization_id = $1`, [orgId]);
    expect(rows[0].n).toBe(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the emails that journey sends', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  // A Pillion customer must never receive mail from an onfleet.africa address.
  // Nothing enforced that before: the sender fell through to a hardcoded
  // OnFleet fallback whatever brand was serving.
  it('come from the serving brand, not a hardcoded OnFleet address', () => {
    for (const k of Object.keys(load.cache)) {
      if (k.includes('/src/brand.js')) delete load.cache[k];
    }
    const prev = process.env.BRAND;
    process.env.BRAND = 'pillion';
    const { brand } = load('../src/brand.js');
    expect(brand.email.from).toBe('support@pillion.co.za');
    expect(brand.email.from).not.toMatch(/onfleet/);
    if (prev === undefined) delete process.env.BRAND; else process.env.BRAND = prev;
  });
});
