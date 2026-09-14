import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgAgreement, authHeader } from './helpers/testPgDb.js';

// The service and routes load axios through Node's require cache, so spying on
// this same instance intercepts their Paystack calls.
const axios = createRequire(import.meta.url)('axios');
const queue = createRequire(import.meta.url)('../src/services/paystackChargeQueue.js');

const app = buildApp();
const SECRET = 'sk_test_charge_queue';
const RIDER_PLAN = 'PLN_test_rider_850';

describe.skipIf(!process.env.DATABASE_URL)('Paystack charge review queue', () => {
  let rider;
  let agreement;
  let admin;

  const charge = (overrides = {}) => ({
    id: 900001,
    reference: `ref-${Math.random().toString(36).slice(2, 10)}`,
    amount: 87642, currency: 'ZAR', channel: 'card', paid_at: new Date().toISOString(),
    plan: { plan_code: RIDER_PLAN, name: 'Rider 850' },
    subscription: { subscription_code: 'SUB_test' },
    customer: { email: rider.email, customer_code: 'CUS_test' },
    authorization: { authorization_code: 'AUTH_must_not_be_stored', last4: '4081' },
    metadata: {},
    ...overrides,
  });
  const count = async (table, where = 'TRUE', params = []) =>
    Number((await pgDb.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params)).rows[0].n);

  beforeEach(async () => {
    await resetAllPgTables();
    process.env.PAYSTACK_SECRET_KEY = SECRET;
    process.env.PAYSTACK_RIDER_PLAN_850 = RIDER_PLAN;
    rider = (await createPgUser({ role: 'rider', email: 'rider.queue@example.test' })).user;
    agreement = await createPgAgreement({ user_id: rider.id, weekly_amount: 850, status: 'active' });
    for (let w = 1; w <= 3; w++) {
      await pgDb.query(`INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, status)
                        VALUES ($1,$2,CURRENT_DATE - $3::int,850,'overdue')`, [agreement.id, w, (4 - w) * 7]);
    }
    admin = (await createPgUser({ role: 'admin' })).user;
  });

  afterEach(() => vi.restoreAllMocks());

  describe('the webhook', () => {
    const send = (event) => {
      const body = JSON.stringify(event);
      const signature = crypto.createHmac('sha512', SECRET).update(body).digest('hex');
      return request(app).post('/api/payments/paystack/webhook')
        .set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(body);
    };

    it('holds a platform rider\'s debit order for review instead of dropping it', async () => {
      // Platform riders have no organisation, and this charge used to vanish at
      // the `if (orgId && ...)` check without a log line.
      const data = charge();
      const res = await send({ event: 'charge.success', data });
      expect(res.status).toBe(200);

      const { rows } = await pgDb.query('SELECT * FROM paystack_charges WHERE reference = $1', [data.reference]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'unconfirmed', source: 'webhook', rider_user_id: rider.id, agreement_id: agreement.id });
      expect(Number(rows[0].amount)).toBe(876.42);
      // Staff also type these in by hand, so nothing is credited until someone confirms.
      expect(await count('payments')).toBe(0);
    });

    it('never stores the card authorisation code, which could charge the card again', async () => {
      const data = charge();
      await send({ event: 'charge.success', data });
      const { rows } = await pgDb.query('SELECT raw FROM paystack_charges WHERE reference = $1', [data.reference]);
      expect(JSON.stringify(rows[0].raw)).not.toContain('AUTH_must_not_be_stored');
    });

    it('queues a charge once however many times Paystack retries it', async () => {
      const data = charge();
      await send({ event: 'charge.success', data });
      await send({ event: 'charge.success', data });
      expect(await count('paystack_charges')).toBe(1);
    });
  });

  describe('queueCharge', () => {
    it('does not queue a charge that is already a payment', async () => {
      const data = charge();
      await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, method, reference, paystack_reference, status)
                        VALUES ($1,$2,876.42,'paystack',$3,$3,'success')`, [agreement.id, rider.id, data.reference]);
      expect(await queue.queueCharge(data)).toBeNull();
      expect(await count('paystack_charges')).toBe(0);
    });

    it('ignores metadata pointing at an agreement that is not the rider\'s', async () => {
      const someoneElse = await createPgAgreement({ status: 'active' });
      const row = await queue.queueCharge(charge({ metadata: { rider_user_id: rider.id, agreement_id: someoneElse.id } }));
      expect(row.agreement_id).toBe(agreement.id);
    });
  });

  describe('confirming', () => {
    it('records the payment with its Paystack reference and applies the rental to the schedule', async () => {
      const row = await queue.queueCharge(charge());
      const result = await queue.confirmCharge(row.id, { creditedAmount: 850, userId: admin.id });

      const { rows: payments } = await pgDb.query('SELECT * FROM payments WHERE id = $1', [result.payment_id]);
      expect(payments[0]).toMatchObject({ reference: row.reference, paystack_reference: row.reference, status: 'success', method: 'paystack' });
      expect(Number(payments[0].amount)).toBe(876.42);
      expect(Number(payments[0].net_amount)).toBe(850);
      expect(Number(payments[0].fee_amount)).toBe(26.42);

      const { rows: weeks } = await pgDb.query(
        'SELECT amount_paid, status FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number', [agreement.id]);
      expect(Number(weeks[0].amount_paid)).toBe(850);
      expect(weeks[0].status).toBe('paid');
      expect(Number(weeks[1].amount_paid)).toBe(0);

      const { rows: after } = await pgDb.query('SELECT status, payment_id, resolved_by FROM paystack_charges WHERE id = $1', [row.id]);
      expect(after[0]).toMatchObject({ status: 'confirmed', payment_id: result.payment_id, resolved_by: admin.id });
    });

    it('credits a charge exactly once when two people confirm it at the same moment', async () => {
      const row = await queue.queueCharge(charge());
      const outcomes = await Promise.allSettled([
        queue.confirmCharge(row.id, { creditedAmount: 850, userId: admin.id }),
        queue.confirmCharge(row.id, { creditedAmount: 850, userId: admin.id }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(await count('payments', 'reference = $1', [row.reference])).toBe(1);
      // The unique index on payments.reference is what makes a double credit
      // impossible. The row lock is what makes the second person see why,
      // instead of a raw duplicate-key failure.
      const loser = outcomes.find((o) => o.status === 'rejected');
      expect(loser.reason.message).toMatch(/already been confirmed/);
      expect(loser.reason.status).toBe(409);
    });

    it('refuses to credit more than was charged', async () => {
      const row = await queue.queueCharge(charge());
      await expect(queue.confirmCharge(row.id, { creditedAmount: 900, userId: admin.id }))
        .rejects.toThrow(/more than the R876.42/);
      expect(await count('payments')).toBe(0);
    });

    it('refuses an agreement that belongs to a different rider', async () => {
      const row = await queue.queueCharge(charge());
      const other = await createPgAgreement({ status: 'active' });
      await expect(queue.confirmCharge(row.id, { agreementId: other.id, creditedAmount: 850, userId: admin.id }))
        .rejects.toThrow(/doesn't belong to the rider/);
    });

    it('refuses a reference that is already recorded, even if the queue row still says unconfirmed', async () => {
      const row = await queue.queueCharge(charge());
      await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, method, reference, status)
                        VALUES ($1,$2,850,'eft',$3,'success')`, [agreement.id, rider.id, row.reference]);
      await expect(queue.confirmCharge(row.id, { creditedAmount: 850, userId: admin.id })).rejects.toThrow(/already recorded/);
    });
  });

  describe('dismissing', () => {
    it('needs a reason, and a dismissed charge can no longer be confirmed', async () => {
      const row = await queue.queueCharge(charge());
      await expect(queue.dismissCharge(row.id, { note: '  ', userId: admin.id })).rejects.toThrow(/why/);
      await queue.dismissCharge(row.id, { note: 'Already entered as a manual payment', userId: admin.id });
      await expect(queue.confirmCharge(row.id, { creditedAmount: 850, userId: admin.id })).rejects.toThrow(/already been dismissed/);
      expect(await count('payments')).toBe(0);
    });
  });

  describe('the review list', () => {
    it('warns when a similar payment is already recorded, and suggests the rental rather than the card total', async () => {
      const row = await queue.queueCharge(charge());
      // The manual entry someone typed in for this debit order.
      await pgDb.query(`INSERT INTO payments (agreement_id, user_id, amount, net_amount, method, reference, status, paid_at)
                        VALUES ($1,$2,850,850,'eft','MAN-typed-in','success',NOW() - INTERVAL '2 days')`, [agreement.id, rider.id]);

      const [listed] = await queue.listCharges({ status: 'unconfirmed' });
      expect(listed.id).toBe(row.id);
      expect(listed.suggested_credit).toBe(850);
      expect(listed.possible_existing_payment).toMatchObject({ reference: 'MAN-typed-in', amount: 850 });
    });

    it('suggests the charge itself when it is not rental plus card fee', () => {
      expect(queue.suggestedCredit(876.42, 850)).toBe(850);   // 850 + 2.9% + R1, within a rand
      expect(queue.suggestedCredit(1000, 1000)).toBe(1000);   // a flat plan with no fee built in
      expect(queue.suggestedCredit(824.92, 850)).toBe(824.92); // doesn't fit this agreement; let a person decide
    });
  });

  describe('duplicate subscriptions', () => {
    const sub = (code, email, status, amount = 87642, createdAt = '2026-08-01T00:00:00Z') => ({
      subscription_code: code, status, amount, createdAt, next_payment_date: '2026-09-20T00:00:00Z',
      customer: { email }, plan: { name: 'Rider 850' }, email_token: `tok_${code}`,
    });

    it('lists only riders with more than one subscription that can still charge them', async () => {
      vi.spyOn(axios, 'get').mockResolvedValue({ data: { data: [
        sub('SUB_a1', rider.email, 'active', 87642, '2026-09-01T00:00:00Z'),
        sub('SUB_a2', rider.email.toUpperCase(), 'attention', 85000, '2026-07-01T00:00:00Z'),
        sub('SUB_a3', rider.email, 'non-renewing'),   // won't charge again
        sub('SUB_b1', 'single@example.test', 'active'),
        sub('SUB_b2', 'single@example.test', 'cancelled'),
      ] } });

      const result = await queue.listDuplicateSubscriptions();
      expect(result.riders).toHaveLength(1);
      expect(result.riders[0]).toMatchObject({ rider_user_id: rider.id, agreement_no: agreement.agreement_no });
      expect(result.riders[0].subscriptions.map((s) => s.subscription_code)).toEqual(['SUB_a1', 'SUB_a2']);
    });

    it('cancels with the subscription\'s own token, and refuses one that can no longer charge', async () => {
      const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: { data: sub('SUB_live', rider.email, 'attention') } });
      const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { status: true } });

      await queue.cancelSubscription('SUB_live', { userId: admin.id });
      expect(post).toHaveBeenCalledWith(expect.stringContaining('/subscription/disable'),
        { code: 'SUB_live', token: 'tok_SUB_live' }, expect.anything());
      expect(await count('audit_logs', `action = 'paystack_subscription.cancelled'`)).toBe(1);

      get.mockResolvedValue({ data: { data: sub('SUB_done', rider.email, 'cancelled') } });
      post.mockClear();
      await expect(queue.cancelSubscription('SUB_done', { userId: admin.id })).rejects.toThrow(/already cancelled/);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('who can use it', () => {
    it('keeps riders out of the queue, and ordinary admins away from cancelling subscriptions', async () => {
      expect((await request(app).get('/api/admin/paystack-charges').set(authHeader(rider))).status).toBe(403);
      expect((await request(app).get('/api/admin/paystack-charges').set(authHeader(admin))).status).toBe(200);
      expect((await request(app).get('/api/admin/paystack-subscriptions/duplicates').set(authHeader(admin))).status).toBe(403);
      expect((await request(app).post('/api/admin/paystack-subscriptions/SUB_x/cancel').set(authHeader(admin))).status).toBe(403);
    });
  });
});
