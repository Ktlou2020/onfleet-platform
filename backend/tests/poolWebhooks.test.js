import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement, authHeader,
} from './helpers/testPgDb.js';

const req = createRequire(import.meta.url);
const poolWebhooks = req('../src/services/poolWebhooks.js');
const dispatcher = req('../src/services/webhookDispatcher.js');
const app = buildApp();

// Pushing pool finance to the funder.
//
// The thing these tests are really guarding is a boundary rather than a
// feature. A funder's endpoint belongs to somebody outside the company. An
// alarm payload carries a rider's name and phone number. Those two facts must
// never meet, and the way they are kept apart — separate endpoint scopes —
// is invisible at the call site, so it is worth proving rather than assuming.

describe.skipIf(!process.env.DATABASE_URL)('pool webhooks', () => {
  let superadmin, pool, otherPool, bike, agreement;

  const createPool = async (fields = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO bike_pools (name, reference, funder, capital_advanced, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fields.name || 'Tranche 1', fields.reference || null, fields.funder || 'SV Capital',
        fields.capital_advanced ?? 90000, superadmin.user.id]);
    return rows[0];
  };

  // created_at is settable because "an endpoint never hears about anything
  // older than itself" is the rule most of these tests turn on.
  const endpoint = async ({ scope = 'funder', poolIds = null, eventTypes = null, createdAt = null, active = true } = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO webhook_endpoints (name, url, secret, scope, pool_ids, event_types, active, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, NOW() - interval '1 day')) RETURNING *`,
      [`${scope} endpoint`, 'https://funder.example/hook', 'whsec_test', scope,
        poolIds, eventTypes, active, superadmin.user.id, createdAt]);
    return rows[0];
  };

  const pay = async (agreementId, { amount = 850, fee = 25.5, net = 824.5, status = 'success', paidAt = null } = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO payments (agreement_id, user_id, amount, fee_amount, net_amount, method, reference, status, paid_at)
       VALUES ($1, (SELECT user_id FROM agreements WHERE id = $1), $2,$3,$4,'paystack',$5,$6,$7) RETURNING *`,
      [agreementId, amount, fee, net, `REF-${crypto.randomBytes(6).toString('hex')}`,
        status, paidAt || new Date().toISOString()]);
    return rows[0];
  };

  const deliveries = async (endpointId) => {
    const { rows } = await pgDb.query(
      `SELECT event_type, event_id, payload FROM webhook_deliveries
        WHERE endpoint_id = $1 ORDER BY id`, [endpointId]);
    return rows.map((r) => ({ ...r, body: JSON.parse(r.payload) }));
  };

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    pool = await createPool({ reference: 'SVC-2026-01' });
    otherPool = await createPool({ name: 'Tranche 2', reference: 'SVC-2026-02', funder: 'Other Funder' });
    bike = await createPgBike({ registration: 'POOL001GP' });
    await pgDb.query('UPDATE bikes SET pool_id = $1 WHERE id = $2', [pool.id, bike.id]);
    agreement = await createPgAgreement({ bike_id: bike.id, weekly_amount: 850, total_weeks: 78 });
    // Nothing in these tests should actually reach the network.
    vi.spyOn(dispatcher, 'flush').mockResolvedValue(0);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('payments', () => {
    it('queues a payment to the funder who paid for the bike', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await pay(agreement.id);

      expect(await poolWebhooks.sweepPayments()).toBe(1);
      const sent = await deliveries(funder.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].event_type).toBe('pool.payment_received');
      expect(sent[0].body.payment).toMatchObject({
        amount_gross: 850, processing_fee: 25.5, amount_net: 824.5,
      });
      expect(sent[0].body.vehicle.registration).toBe('POOL001GP');
      expect(sent[0].body.pool.reference).toBe('SVC-2026-01');
    });

    // The sweep runs every minute over a seven-day window. If it were not
    // idempotent the funder would receive the same receipt ten thousand times.
    it('sends the same payment exactly once however often it sweeps', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await pay(agreement.id);

      await poolWebhooks.sweepPayments();
      await poolWebhooks.sweepPayments();
      await poolWebhooks.sweepPayments();

      expect(await deliveries(funder.id), 'the sweep re-sent a receipt it had already delivered').toHaveLength(1);
    });

    // The reason this sweeps instead of hooking the insert: Paystack writes a
    // pending row and marks it successful later. A watermark on the payment id
    // would have passed it by.
    it('catches a payment that only became successful later', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      const pending = await pay(agreement.id, { status: 'pending' });

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id)).toHaveLength(0);

      await pgDb.query(`UPDATE payments SET status = 'success' WHERE id = $1`, [pending.id]);
      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id), 'a payment that settled late was never reported').toHaveLength(1);
    });

    it('never sends a failed or refunded payment', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await pay(agreement.id, { status: 'failed' });
      await pay(agreement.id, { status: 'refunded' });

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id)).toHaveLength(0);
    });

    it('does not replay history at an endpoint registered today', async () => {
      const old = new Date(Date.now() - 3 * 86400_000).toISOString();
      await pay(agreement.id, { paidAt: old });
      const funder = await endpoint({ poolIds: [pool.id], createdAt: new Date().toISOString() });

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id),
        'registering a URL replayed a week the funder had already reconciled').toHaveLength(0);
    });

    it('leaves a payment outside the lookback window alone', async () => {
      const funder = await endpoint({ poolIds: [pool.id], createdAt: new Date(Date.now() - 60 * 86400_000).toISOString() });
      await pay(agreement.id, { paidAt: new Date(Date.now() - 30 * 86400_000).toISOString() });

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id)).toHaveLength(0);
    });

    it('ignores a payment on a bike that is in no pool at all', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      const loose = await createPgBike({ registration: 'LOOSE01GP' });
      const looseAgreement = await createPgAgreement({ bike_id: loose.id });
      await pay(looseAgreement.id);

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id)).toHaveLength(0);
    });
  });

  describe('who receives what', () => {
    it('sends nothing about one funder\'s pool to another funder', async () => {
      const ours = await endpoint({ poolIds: [pool.id] });
      const theirs = await endpoint({ poolIds: [otherPool.id] });
      await pay(agreement.id);

      await poolWebhooks.sweepPayments();
      expect(await deliveries(ours.id)).toHaveLength(1);
      expect(await deliveries(theirs.id), 'a funder was sent another tranche\'s receipts').toHaveLength(0);
    });

    // The boundary this whole feature rests on. An alarm payload carries a
    // rider's name and phone number; a funder's endpoint is outside the
    // company. They are kept apart by scope, which is invisible at the call
    // site — so it is checked from both directions.
    it('never sends an alarm to a funder endpoint', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      const { rows: alertRows } = await pgDb.query(
        `INSERT INTO tracking_alerts (bike_id, alert_type, severity, payload)
         VALUES ($1, 'theft_risk', 'critical', '{"level":"critical"}') RETURNING *`, [bike.id]);

      await dispatcher.queueAlert(alertRows[0]);
      expect(await deliveries(funder.id),
        'a funder was sent an alarm, which carries a rider\'s name and number').toHaveLength(0);
    });

    it('never sends pool finance to a control room endpoint', async () => {
      const platform = await endpoint({ scope: 'platform', poolIds: null });
      await pay(agreement.id);

      await poolWebhooks.sweepPayments();
      expect(await deliveries(platform.id),
        'an alarm integrator was sent the fleet\'s payment records').toHaveLength(0);
    });

    it('skips a paused endpoint', async () => {
      const funder = await endpoint({ poolIds: [pool.id], active: false });
      await pay(agreement.id);

      await poolWebhooks.sweepPayments();
      expect(await deliveries(funder.id)).toHaveLength(0);
    });

    it('honours a pinned event list', async () => {
      const summaryOnly = await endpoint({ poolIds: [pool.id], eventTypes: 'pool.daily_summary' });
      await pay(agreement.id);

      await poolWebhooks.sweepPayments();
      expect(await deliveries(summaryOnly.id)).toHaveLength(0);

      await poolWebhooks.sendDailySummaries();
      expect(await deliveries(summaryOnly.id)).toHaveLength(1);
    });

    it('an endpoint covering both pools hears about both', async () => {
      const both = await endpoint({ poolIds: [pool.id, otherPool.id] });
      const second = await createPgBike({ registration: 'POOL002GP' });
      await pgDb.query('UPDATE bikes SET pool_id = $1 WHERE id = $2', [otherPool.id, second.id]);
      const secondAgreement = await createPgAgreement({ bike_id: second.id });

      await pay(agreement.id);
      await pay(secondAgreement.id);
      await poolWebhooks.sweepPayments();

      expect(await deliveries(both.id)).toHaveLength(2);
    });
  });

  describe('the daily position', () => {
    it('carries the whole summary block', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await pay(agreement.id);

      expect(await poolWebhooks.sendDailySummaries()).toBe(1);
      const [sent] = await deliveries(funder.id);
      expect(sent.event_type).toBe('pool.daily_summary');
      expect(sent.body.summary).toMatchObject({
        contracted_total: 66300, collected_gross: 850, collected_net: 824.5,
      });
      expect(sent.body.as_at_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    // A restarted container or a second cron fire must not send two.
    it('sends one a day however many times it runs', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await poolWebhooks.sendDailySummaries();
      await poolWebhooks.sendDailySummaries();
      expect(await deliveries(funder.id)).toHaveLength(1);
    });

    // Both days are relative to now, and the endpoint is created well before
    // them. Pinning them to absolute dates made this pass on the day it was
    // written and fail afterwards: the endpoint fixture is created relative to
    // NOW(), the summary skips anything older than its endpoint, and so by the
    // following week both runs were being skipped and the test was asserting
    // nothing. The same mistake as anchoring a fixture to the database clock
    // while handing the code under test a fake one.
    it('sends a fresh one the next day', async () => {
      const funder = await endpoint({
        poolIds: [pool.id],
        createdAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
      });
      const yesterday = new Date(Date.now() - 86400_000);
      const today = new Date();

      await poolWebhooks.sendDailySummaries({ at: yesterday });
      await poolWebhooks.sendDailySummaries({ at: today });
      expect(await deliveries(funder.id)).toHaveLength(2);
    });
  });

  describe('bikes moving between tranches', () => {
    it('tells the funder gaining the bikes and the one losing them', async () => {
      const gaining = await endpoint({ poolIds: [pool.id] });
      const losing = await endpoint({ poolIds: [otherPool.id] });
      const moving = await createPgBike({ registration: 'MOVE001GP' });
      await pgDb.query('UPDATE bikes SET pool_id = $1 WHERE id = $2', [otherPool.id, moving.id]);

      await request(app).post(`/api/admin/pools/${pool.id}/bikes`)
        .set(authHeader(superadmin.user)).send({ bike_ids: [moving.id] });
      // The route fires these without awaiting, so that a webhook cannot make
      // an admin wait; give the event loop a turn before reading.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const gained = await deliveries(gaining.id);
      expect(gained).toHaveLength(1);
      expect(gained[0].body.added[0].registration).toBe('MOVE001GP');

      const lost = await deliveries(losing.id);
      expect(lost, 'the funder whose tranche shrank was not told').toHaveLength(1);
      expect(lost[0].body.removed[0].registration).toBe('MOVE001GP');
    });

    it('tells the funder when a bike is taken out', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      await request(app).delete(`/api/admin/pools/${pool.id}/bikes/${bike.id}`)
        .set(authHeader(superadmin.user));
      await new Promise((resolve) => setTimeout(resolve, 150));

      const sent = await deliveries(funder.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].body.removed[0].registration).toBe('POOL001GP');
    });
  });

  describe('no rider ever appears', () => {
    it('in any pool event, whatever the shape', async () => {
      const funder = await endpoint({ poolIds: [pool.id] });
      const { rows } = await pgDb.query('SELECT full_name, phone, email FROM users WHERE id = $1', [agreement.user_id]);
      const rider = rows[0];

      await pay(agreement.id);
      await poolWebhooks.sweepPayments();
      await poolWebhooks.sendDailySummaries();
      await poolWebhooks.emitCompositionChanged(pool.id, { added: [{ id: bike.id, registration: 'POOL001GP' }] });

      const sent = await deliveries(funder.id);
      expect(sent.length).toBeGreaterThanOrEqual(3);
      for (const d of sent) {
        expect(d.payload, `${d.event_type} leaked a rider name`).not.toContain(rider.full_name);
        if (rider.phone) expect(d.payload, `${d.event_type} leaked a phone`).not.toContain(rider.phone);
        if (rider.email) expect(d.payload, `${d.event_type} leaked an email`).not.toContain(rider.email);
        expect(d.payload).not.toContain('rider_name');
        expect(d.payload).not.toContain('driver');
      }
    });
  });

  describe('registering one', () => {
    it('creates a funder webhook against named pools', async () => {
      const res = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({ name: 'SV Capital', url: 'https://svcapital.example/hooks/onfleet', scope: 'funder', pool_ids: [pool.id] });
      expect(res.status).toBe(201);
      expect(res.body.scope).toBe('funder');
      expect(res.body.pool_ids).toEqual([pool.id]);
      expect(res.body.secret).toMatch(/^whsec_/);
    });

    it('refuses a funder webhook that names no pool', async () => {
      const res = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({ name: 'SV Capital', url: 'https://svcapital.example/h', scope: 'funder', pool_ids: [] });
      expect(res.status).toBe(400);
    });

    it('still insists on HTTPS', async () => {
      const res = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({ name: 'SV Capital', url: 'http://svcapital.example/h', scope: 'funder', pool_ids: [pool.id] });
      expect(res.status).toBe(400);
    });

    // The two vocabularies do not overlap, and validating one against the
    // other rejects every valid answer.
    it('validates a funder\'s event list against the pool events, not the alarms', async () => {
      const ok = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({
          name: 'SV Capital', url: 'https://svcapital.example/h', scope: 'funder',
          pool_ids: [pool.id], event_types: ['pool.payment_received'],
        });
      expect(ok.status).toBe(201);

      const nope = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({
          name: 'SV Capital', url: 'https://svcapital.example/h2', scope: 'funder',
          pool_ids: [pool.id], event_types: ['theft_risk'],
        });
      expect(nope.status).toBe(400);
    });

    it('lets a funder endpoint\'s event list be edited afterwards', async () => {
      const created = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(superadmin.user))
        .send({ name: 'SV Capital', url: 'https://svcapital.example/h', scope: 'funder', pool_ids: [pool.id] });

      const res = await request(app).put(`/api/admin/integrations/webhooks/${created.body.id}`)
        .set(authHeader(superadmin.user)).send({ event_types: ['pool.daily_summary'] });
      expect(res.status, 'editing a funder endpoint validated against the alarm catalogue').toBe(200);
      expect(res.body.webhook.event_types).toBe('pool.daily_summary');
    });

    it('an ordinary admin cannot register one', async () => {
      const admin = await createPgUser({ role: 'admin' });
      const res = await request(app).post('/api/admin/integrations/webhooks')
        .set(authHeader(admin.user))
        .send({ name: 'SV Capital', url: 'https://svcapital.example/h', scope: 'funder', pool_ids: [pool.id] });
      expect(res.status).toBe(403);
    });
  });
});
