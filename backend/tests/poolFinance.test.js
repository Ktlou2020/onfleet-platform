import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike,
  createPgAgreement, createPgPaymentSchedule, authHeader,
} from './helpers/testPgDb.js';

const poolFinance = createRequire(import.meta.url)('../src/services/poolFinance.js');
const app = buildApp();

// Sharing a pool's finances with the funder who paid for it.
//
// Two things these tests care about, and they pull in different directions.
//
// The money has to be right, and right in a particular way: every total must
// equal the sum of the rows underneath it. A funder who adds up the breakdown
// and gets a different answer from the header stops believing the rest of the
// response, and they should.
//
// And the key has to see only the money. A funder key is handed to somebody
// outside the company. If it can reach a rider's name, a phone number, or
// another funder's tranche, that is not a bug to fix later.

const dayOffset = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!process.env.DATABASE_URL)('bike pool finance', () => {
  let superadmin, org, pool, otherPool, bike, agreement;

  const createPool = async (fields = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO bike_pools (name, reference, funder, capital_advanced, advanced_on, organization_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [fields.name || 'Tranche 1', fields.reference || null, fields.funder || 'SV Capital',
        fields.capital_advanced ?? null, fields.advanced_on || null,
        fields.organization_id || null, superadmin.user.id]);
    return rows[0];
  };

  const issueKey = async ({ scope = 'platform', poolIds = null, orgId = null } = {}) => {
    const raw = `onfleet_${scope === 'funder' ? 'fund' : 'plat'}_${crypto.randomBytes(16).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await pgDb.query(
      `INSERT INTO api_keys (organization_id, created_by, name, key_hash, key_prefix, scope, pool_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, superadmin.user.id, `${scope} key`, hash, raw.slice(0, 21), scope, poolIds]);
    return raw;
  };

  const asKey = (key) => ({ Authorization: `Bearer ${key}` });

  // createPgBike knows nothing about pools or what a bike cost, so both are
  // set here rather than scattered through the tests.
  const poolBike = async (poolId, fields = {}) => {
    const created = await createPgBike(fields);
    await pgDb.query('UPDATE bikes SET pool_id = $1, purchase_price = $2 WHERE id = $3',
      [poolId, fields.purchase_price ?? null, created.id]);
    return created;
  };

  const pay = async (agreementId, { amount, fee = 0, net = null, status = 'success', method = 'paystack', paidAt = null } = {}) =>
    pgDb.query(
      `INSERT INTO payments (agreement_id, user_id, amount, fee_amount, net_amount, method, reference, status, paid_at)
       VALUES ($1, (SELECT user_id FROM agreements WHERE id = $1), $2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [agreementId, amount, fee, net, method, `REF-${crypto.randomBytes(6).toString('hex')}`,
        status, paidAt || new Date().toISOString()]);

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    org = await createPgOrg({ name: 'Rapid Wheels' });

    pool = await createPool({ reference: 'SVC-2026-01', capital_advanced: 90000 });
    otherPool = await createPool({ name: 'Tranche 2', reference: 'SVC-2026-02', funder: 'Other Funder' });

    bike = await poolBike(pool.id, { registration: 'POOL001GP', organization_id: org.id, purchase_price: 28000 });
    // R850 a week for 78 weeks — R66,300 contracted.
    agreement = await createPgAgreement({ bike_id: bike.id, weekly_amount: 850, total_weeks: 78 });
  });

  describe('the arithmetic', () => {
    it('reports what was contracted, collected and is still outstanding', async () => {
      await pay(agreement.id, { amount: 850 });
      await pay(agreement.id, { amount: 850 });

      const { summary } = await poolFinance.position(pool.id);

      expect(summary.contracted_total).toBe(66300);
      expect(summary.collected_gross).toBe(1700);
      expect(summary.outstanding).toBe(64600);
      expect(summary.paid_off_pct).toBe(2.6);
    });

    // The bug this exists to prevent: net_amount is only written for Paystack.
    // A cash payment stores 0, and reading that as "nothing arrived" would
    // under-report every fleet that takes cash — which is most of them.
    it('does not read a cash payment as money that never arrived', async () => {
      await pay(agreement.id, { amount: 850, fee: 0, net: 0, method: 'cash' });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.collected_gross).toBe(850);
      expect(summary.collected_net, 'a cash payment was counted as zero cash').toBe(850);
      expect(summary.processing_fees).toBe(0);
    });

    it('keeps the processing fee out of what actually landed', async () => {
      await pay(agreement.id, { amount: 850, fee: 25.5, net: 824.5 });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.collected_gross).toBe(850);
      expect(summary.collected_net).toBe(824.5);
      expect(summary.processing_fees).toBe(25.5);
    });

    it('counts only successful payments', async () => {
      await pay(agreement.id, { amount: 850, status: 'success' });
      await pay(agreement.id, { amount: 850, status: 'failed' });
      await pay(agreement.id, { amount: 850, status: 'refunded' });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.collected_gross).toBe(850);
    });

    it('ages arrears by how late the money is', async () => {
      const overdue = [[-15, 'days_1_30'], [-45, 'days_31_60'], [-75, 'days_61_90'], [-120, 'days_90_plus']];
      let week = 1;
      for (const [offset] of overdue) {
        await createPgPaymentSchedule({
          agreement_id: agreement.id, week_number: week++, due_date: dayOffset(offset),
          amount_due: 850, amount_paid: 0, status: 'overdue',
        });
      }

      const { summary } = await poolFinance.position(pool.id);
      for (const [, bucket] of overdue) {
        expect(summary.arrears_by_age[bucket], `bucket ${bucket}`).toBe(850);
      }
      expect(summary.arrears_total).toBe(3400);
    });

    it('does not call a future instalment arrears', async () => {
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 1, due_date: dayOffset(14),
        amount_due: 850, amount_paid: 0, status: 'pending',
      });
      const { summary } = await poolFinance.position(pool.id);
      expect(summary.billed_to_date, 'money not yet due was billed').toBe(0);
      expect(summary.arrears_total).toBe(0);
    });

    it('leaves a waived week out of what was billed', async () => {
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 1, due_date: dayOffset(-10),
        amount_due: 850, amount_paid: 0, status: 'waived',
      });
      const { summary } = await poolFinance.position(pool.id);
      expect(summary.billed_to_date).toBe(0);
      expect(summary.arrears_total).toBe(0);
    });

    it('rates collection against what fell due, not against the contract', async () => {
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 1, due_date: dayOffset(-14),
        amount_due: 850, amount_paid: 850, status: 'paid',
      });
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 2, due_date: dayOffset(-7),
        amount_due: 850, amount_paid: 0, status: 'overdue',
      });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.billed_to_date).toBe(1700);
      expect(summary.collected_against_billed).toBe(850);
      expect(summary.collection_rate_pct, 'the rate was measured against the whole contract').toBe(50);
    });

    // A stolen bike's outstanding balance is not merely late, and a funder
    // reading one number for both would think the pool is recoverable.
    it('separates a stolen bike\'s balance from money that is only behind', async () => {
      await pay(agreement.id, { amount: 850 });
      await pgDb.query(`UPDATE bikes SET status = 'stolen' WHERE id = $1`, [bike.id]);

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.capital_at_risk).toBe(65450);
    });

    it('measures recovery against the capital the funder actually advanced', async () => {
      await pay(agreement.id, { amount: 45000, fee: 0, net: 45000, method: 'eft' });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.capital_advanced).toBe(90000);
      expect(summary.capital_recovery_pct).toBe(50);
      expect(summary.recovered_against_capital).toBe(-45000);
      // Not the same thing as the sum of our own purchase prices, which is
      // what the bikes cost us rather than what was wired.
      expect(summary.cost_basis).toBe(28000);
    });

    // A pool can report money collected and a collection rate of zero at the
    // same time, truthfully: payments are cash that arrived, the schedule is
    // cash applied to a week. Without a name for the gap a funder cannot tell
    // which of the two numbers to believe.
    it('names cash that has arrived but has not been applied to a week', async () => {
      await pay(agreement.id, { amount: 850 });
      await pay(agreement.id, { amount: 850 });
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 1, due_date: dayOffset(-7),
        amount_due: 850, amount_paid: 850, status: 'paid',
      });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.collected_gross).toBe(1700);
      expect(summary.collected_allocated).toBe(850);
      expect(summary.unallocated_cash, 'the gap between cash in and cash applied went unreported').toBe(850);
    });

    it('reports no gap when every receipt has been applied', async () => {
      await pay(agreement.id, { amount: 850 });
      await createPgPaymentSchedule({
        agreement_id: agreement.id, week_number: 1, due_date: dayOffset(-7),
        amount_due: 850, amount_paid: 850, status: 'paid',
      });

      const { summary } = await poolFinance.position(pool.id);
      expect(summary.unallocated_cash).toBe(0);
      expect(summary.collection_rate_pct).toBe(100);
    });

    // The property that makes the whole response trustworthy.
    it('totals that equal the sum of the rows beneath them', async () => {
      const second = await poolBike(pool.id, { registration: 'POOL002GP', purchase_price: 31000 });
      const secondAgreement = await createPgAgreement({ bike_id: second.id, weekly_amount: 900, total_weeks: 52 });

      await pay(agreement.id, { amount: 850, fee: 25, net: 825 });
      await pay(secondAgreement.id, { amount: 900, fee: 27, net: 873 });

      const { summary, bikes } = await poolFinance.position(pool.id);
      const sum = (f) => Math.round(bikes.reduce((t, b) => t + b[f], 0) * 100) / 100;

      expect(summary.contracted_total).toBe(sum('contracted_total'));
      expect(summary.collected_gross).toBe(sum('collected_gross'));
      expect(summary.collected_net).toBe(sum('collected_net'));
      expect(summary.processing_fees).toBe(sum('processing_fees'));
      expect(summary.outstanding).toBe(sum('outstanding'));
      expect(summary.cost_basis).toBe(sum('cost_basis'));
      expect(summary.collected_allocated).toBe(sum('allocated_to_weeks'));
      expect(summary.unallocated_cash).toBe(sum('unallocated_cash'));
      expect(summary.bikes).toBe(2);
    });

    it('counts a bike with no rider as earning nothing rather than crashing', async () => {
      const idle = await poolBike(pool.id, { registration: 'POOL003GP', status: 'ready_to_go', purchase_price: 29000 });

      const { summary, bikes } = await poolFinance.position(pool.id);
      const row = bikes.find((b) => b.registration === 'POOL003GP');
      expect(row.current_agreement).toBeNull();
      expect(row.contracted_total).toBe(0);
      expect(summary.bikes).toBe(2);
      expect(summary.bikes_earning).toBe(1);
    });
  });

  describe('what a funder key can reach', () => {
    let funderKey, platformKey;

    beforeEach(async () => {
      funderKey = await issueKey({ scope: 'funder', poolIds: [pool.id] });
      platformKey = await issueKey({ scope: 'platform' });
      await pay(agreement.id, { amount: 850 });
    });

    it('reads the pool it was issued for', async () => {
      const res = await request(app).get(`/api/v1/pools/${pool.id}`).set(asKey(funderKey));
      expect(res.status).toBe(200);
      expect(res.body.pool.reference).toBe('SVC-2026-01');
      expect(res.body.summary.collected_gross).toBe(850);
    });

    it('lists only its own pools', async () => {
      const res = await request(app).get('/api/v1/pools').set(asKey(funderKey));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.pools[0].id).toBe(pool.id);
    });

    // 404 and not 403: the difference between the two is a way to find out
    // which other tranches exist by walking the ids.
    it('cannot tell that another funder\'s pool exists', async () => {
      const res = await request(app).get(`/api/v1/pools/${otherPool.id}`).set(asKey(funderKey));
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Other Funder');
    });

    it('cannot read another pool\'s payments either', async () => {
      const res = await request(app).get(`/api/v1/pools/${otherPool.id}/payments`).set(asKey(funderKey));
      expect(res.status).toBe(404);
    });

    // Default-deny. A route added to this API next year is out of a funder's
    // reach until somebody decides otherwise on purpose.
    it.each(['/api/v1/vehicles', '/api/v1/riders', '/api/v1/alerts', '/api/v1/agreements', '/api/v1/bikes', '/api/v1/groups'])(
      'is refused %s', async (path) => {
        const res = await request(app).get(path).set(asKey(funderKey));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FUNDER_KEY_SCOPE');
      });

    // The one that matters most. This key leaves the building.
    it('is never handed a rider\'s name or phone number', async () => {
      const rider = await pgDb.query('SELECT full_name, phone FROM users WHERE id = $1', [agreement.user_id]);
      const { full_name: name, phone } = rider.rows[0];

      for (const path of [`/pools`, `/pools/${pool.id}`, `/pools/${pool.id}/payments`]) {
        const res = await request(app).get(`/api/v1${path}`).set(asKey(funderKey));
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body, `${path} leaked a rider name`).not.toContain(name);
        if (phone) expect(body, `${path} leaked a rider phone`).not.toContain(phone);
        expect(body).not.toContain('rider_name');
        expect(body).not.toContain('rider_phone');
      }
    });

    // A key allowed to see nothing must see nothing. The database constraint
    // stops a funder key being issued with an empty pool list, so this is a
    // second line rather than a reachable path — but "restricted to nothing"
    // and "no restriction" looking alike is exactly how scoping bugs start,
    // and the service is the place that decides.
    it('a scope of no pools at all returns no pools, not every pool', async () => {
      expect(await poolFinance.list({ poolIds: [] })).toEqual([]);
      expect((await poolFinance.list({})).length, 'the unrestricted case stopped working').toBe(2);
    });

    it('a revoked key stops working immediately', async () => {
      await pgDb.query('UPDATE api_keys SET revoked_at = NOW() WHERE scope = $1', ['funder']);
      const res = await request(app).get('/api/v1/pools').set(asKey(funderKey));
      expect(res.status).toBe(401);
    });

    it('a platform key still sees every pool', async () => {
      const res = await request(app).get('/api/v1/pools').set(asKey(platformKey));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(2);
    });

    it('an organization key sees only its own fleet\'s pools', async () => {
      await pgDb.query('UPDATE bike_pools SET organization_id = $1 WHERE id = $2', [org.id, pool.id]);
      const orgKey = await issueKey({ scope: 'organization', orgId: org.id });

      const res = await request(app).get('/api/v1/pools').set(asKey(orgKey));
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.pools[0].id).toBe(pool.id);
    });
  });

  describe('the payments feed', () => {
    let funderKey;
    beforeEach(async () => {
      funderKey = await issueKey({ scope: 'funder', poolIds: [pool.id] });
    });

    it('returns each payment with its fee broken out', async () => {
      await pay(agreement.id, { amount: 850, fee: 25.5, net: 824.5 });
      const res = await request(app).get(`/api/v1/pools/${pool.id}/payments`).set(asKey(funderKey));

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.payments[0]).toMatchObject({
        amount_gross: 850, processing_fee: 25.5, amount_net: 824.5, method: 'paystack',
      });
      expect(res.body.payments[0].vehicle.registration).toBe('POOL001GP');
    });

    it('takes `since` so a nightly job is incremental', async () => {
      await pay(agreement.id, { amount: 850, paidAt: '2026-01-10T08:00:00Z' });
      await pay(agreement.id, { amount: 850, paidAt: '2026-06-10T08:00:00Z' });

      const res = await request(app)
        .get(`/api/v1/pools/${pool.id}/payments?since=2026-03-01T00:00:00Z`).set(asKey(funderKey));
      expect(res.body.count).toBe(1);
      expect(res.body.payments[0].paid_at).toContain('2026-06-10');
    });

    it('refuses a `since` it cannot parse rather than silently returning everything', async () => {
      const res = await request(app)
        .get(`/api/v1/pools/${pool.id}/payments?since=last-tuesday`).set(asKey(funderKey));
      expect(res.status).toBe(400);
    });

    it('never includes a payment from another pool', async () => {
      const outside = await poolBike(otherPool.id, { registration: 'OTHER01GP' });
      const outsideAgreement = await createPgAgreement({ bike_id: outside.id });
      await pay(outsideAgreement.id, { amount: 5000 });
      await pay(agreement.id, { amount: 850 });

      const res = await request(app).get(`/api/v1/pools/${pool.id}/payments`).set(asKey(funderKey));
      expect(res.body.count).toBe(1);
      expect(res.body.payments[0].amount_gross).toBe(850);
    });
  });

  describe('running pools from the admin side', () => {
    it('creates a pool', async () => {
      const res = await request(app).post('/api/admin/pools').set(authHeader(superadmin.user))
        .send({ name: 'Tranche 3', funder: 'SV Capital', reference: 'SVC-2026-03', capital_advanced: 500000 });
      expect(res.status).toBe(201);
      expect(res.body.pool.funder).toBe('SV Capital');
    });

    it('refuses a reference that differs only in case', async () => {
      const res = await request(app).post('/api/admin/pools').set(authHeader(superadmin.user))
        .send({ name: 'Dup', funder: 'SV Capital', reference: 'svc-2026-01' });
      expect(res.status, 'two pools whose references differ only in case').toBe(409);
    });

    it('assigns bikes and records which pool they came from', async () => {
      const moving = await poolBike(otherPool.id, { registration: 'MOVE001GP' });

      const res = await request(app).post(`/api/admin/pools/${pool.id}/bikes`)
        .set(authHeader(superadmin.user)).send({ bike_ids: [moving.id] });
      expect(res.status).toBe(200);
      expect(res.body.reassigned).toBe(1);

      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'admin.pool_bikes_add' ORDER BY id DESC LIMIT 1`);
      const details = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      expect(details.reassigned_from[0].pool_id, 'the funder it moved away from was not recorded').toBe(otherPool.id);
    });

    it('removes a bike from a pool', async () => {
      const res = await request(app).delete(`/api/admin/pools/${pool.id}/bikes/${bike.id}`)
        .set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query('SELECT pool_id FROM bikes WHERE id = $1', [bike.id]);
      expect(rows[0].pool_id).toBeNull();
    });

    it('will not issue a funder key that names no pool', async () => {
      const res = await request(app).post('/api/admin/integrations/api-keys')
        .set(authHeader(superadmin.user)).send({ name: 'SV Capital', scope: 'funder', pool_ids: [] });
      expect(res.status).toBe(400);
    });

    it('will not issue a funder key for a pool that does not exist', async () => {
      const res = await request(app).post('/api/admin/integrations/api-keys')
        .set(authHeader(superadmin.user)).send({ name: 'SV Capital', scope: 'funder', pool_ids: [999999] });
      expect(res.status).toBe(400);
    });

    it('issues a funder key once and stores only its hash', async () => {
      const res = await request(app).post('/api/admin/integrations/api-keys')
        .set(authHeader(superadmin.user)).send({ name: 'SV Capital', scope: 'funder', pool_ids: [pool.id] });
      expect(res.status).toBe(201);
      expect(res.body.key).toMatch(/^onfleet_fund_/);
      expect(res.body.pool_ids).toEqual([pool.id]);

      const { rows } = await pgDb.query('SELECT key_hash, pool_ids FROM api_keys WHERE id = $1', [res.body.key_id]);
      expect(rows[0].key_hash).not.toBe(res.body.key);
      expect(rows[0].pool_ids).toEqual([pool.id]);
    });

    it('an ordinary admin cannot move bikes between funders', async () => {
      const admin = await createPgUser({ role: 'admin' });
      const res = await request(app).post(`/api/admin/pools/${pool.id}/bikes`)
        .set(authHeader(admin.user)).send({ bike_ids: [bike.id] });
      expect(res.status).toBe(403);
    });
  });
});
