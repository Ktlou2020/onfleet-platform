import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { resetAllPgTables, createPgUser, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const axios = createRequire(import.meta.url)('axios');
const app = buildApp();

// Every payment link initialises a new Paystack subscription, and nothing
// cancelled the one before it: 51 riders ended up with several live at once,
// and some were charged twice in a day.
describe.skipIf(!process.env.DATABASE_URL)('POST /api/agreements/:id/subscription/init', () => {
  let admin;
  let agreement;
  let rider;
  let initialize;

  const paystack = ({ customer, subscriptions, customerStatus = 200, failWith = null } = {}) => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (failWith) throw failWith;
      if (url.includes('/customer/')) {
        if (customerStatus === 404) throw Object.assign(new Error('not found'), { response: { status: 404, data: { message: 'Customer not found' } } });
        return { data: { data: customer } };
      }
      if (url.endsWith('/subscription')) return { data: { data: subscriptions || [] } };
      throw new Error(`unexpected GET ${url}`);
    });
  };
  const generate = () => request(app).post(`/api/agreements/${agreement.id}/subscription/init`).set(authHeader(admin)).send({});

  beforeEach(async () => {
    await resetAllPgTables();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_guard';
    process.env.PAYSTACK_RIDER_PLAN_850 = 'PLN_guard_850';
    admin = (await createPgUser({ role: 'admin' })).user;
    rider = (await createPgUser({ role: 'rider', email: 'guarded.rider@example.test' })).user;
    agreement = await createPgAgreement({ user_id: rider.id, weekly_amount: 850, status: 'active' });
    initialize = vi.spyOn(axios, 'post').mockResolvedValue({ data: { data: { authorization_url: 'https://checkout.paystack.test/x', access_code: 'ac' } } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses a second link while the rider has a subscription Paystack is still retrying', async () => {
    // Exactly what production returned: the customer record's embedded list is
    // empty while ten live subscriptions exist. Trusting that list let duplicates through.
    paystack({
      customer: { id: 304496282, email: rider.email, subscriptions: [] },
      subscriptions: [
        { subscription_code: 'SUB_retrying', status: 'attention', amount: 80000, next_payment_date: '2026-09-20' },
        { subscription_code: 'SUB_old', status: 'cancelled', amount: 80000 },
      ],
    });
    const res = await generate();
    expect(res.status).toBe(409);
    expect(res.body.subscriptions.map((s) => s.subscription_code)).toEqual(['SUB_retrying']);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('asks Paystack for subscriptions by the customer\'s id', async () => {
    paystack({ customer: { id: 42, email: rider.email }, subscriptions: [] });
    await generate();
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/subscription$/),
      expect.objectContaining({ params: expect.objectContaining({ customer: 42 }) }));
  });

  it('generates the first link for a rider Paystack has never seen', async () => {
    paystack({ customerStatus: 404 });
    const res = await generate();
    expect(res.status).toBe(200);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('allows a new link when the only remaining subscriptions will not charge again', async () => {
    paystack({
      customer: { id: 7, email: rider.email },
      subscriptions: [{ subscription_code: 'SUB_ending', status: 'non-renewing' }, { subscription_code: 'SUB_gone', status: 'cancelled' }],
    });
    expect((await generate()).status).toBe(200);
  });

  it('refuses rather than guesses when Paystack cannot be reached', async () => {
    paystack({ failWith: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const res = await generate();
    expect(res.status).toBe(502);
    expect(initialize).not.toHaveBeenCalled();
  });
});
