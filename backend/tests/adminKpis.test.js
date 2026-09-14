import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// Every date comes from Postgres relative to CURRENT_DATE, the same clock the
// endpoint reads, so a test run at midnight on the 1st can't land a row in the
// wrong month.
const sqlDate = async (expr) => (await pgDb.query(`SELECT (${expr})::date::text AS d`)).rows[0].d;
const lastMonth = (day) => sqlDate(`date_trunc('month', CURRENT_DATE) - INTERVAL '1 month' + INTERVAL '${day - 1} days'`);
const daysAgo = (n) => sqlDate(`CURRENT_DATE - ${n}`);

describe.skipIf(!process.env.DATABASE_URL)('GET /api/admin/kpis', () => {
  let admin;
  let prevMonthKey;

  const schedule = (agreementId, due, amount, { paid = 0, status = 'pending', week = 1 } = {}) => pgDb.query(
    `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
     VALUES ($1,$2,$3,$4,$5,$6)`, [agreementId, week, due, amount, paid, status]);
  const payment = (agreement, amount, paidAt) => pgDb.query(
    `INSERT INTO payments (agreement_id, user_id, amount, net_amount, method, status, paid_at)
     VALUES ($1,$2,$3,$3,'eft','success',$4)`, [agreement.id, agreement.user_id, amount, paidAt]);
  const agreement = async (overrides = {}) => {
    const { discontinued_at, ...rest } = overrides;
    const ag = await createPgAgreement(rest);
    if (discontinued_at) await pgDb.query('UPDATE agreements SET discontinued_at = $1 WHERE id = $2', [discontinued_at, ag.id]);
    return ag;
  };
  const kpis = async () => {
    const res = await request(app).get('/api/admin/kpis').set(authHeader(admin));
    expect(res.status).toBe(200);
    return res.body;
  };
  const month = (body, key) => body.collections.months.find((m) => m.month === key);

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    prevMonthKey = (await pgDb.query(
      `SELECT to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM') AS m`)).rows[0].m;
  });

  it('stops counting billing on the day an agreement was discontinued', async () => {
    const running = await agreement({ status: 'active' });
    await schedule(running.id, await lastMonth(6), 1000, { paid: 1000, status: 'paid' });
    await payment(running, 1000, await lastMonth(6));

    // Discontinued on the 3rd. The week due on the 1st was genuinely owed; the
    // week due on the 10th only exists because the schedule outlived the bike.
    const ended = await agreement({ status: 'discontinued', discontinued_at: await lastMonth(3) });
    await schedule(ended.id, await lastMonth(1), 500, { status: 'overdue', week: 1 });
    await schedule(ended.id, await lastMonth(10), 500, { status: 'overdue', week: 2 });

    const m = month(await kpis(), prevMonthKey);
    expect(m.billed).toBe(1500);      // counting the phantom week too gives 2000 and a 50% rate
    expect(m.collected).toBe(1000);
    expect(m.rate).toBe(66.7);
  });

  it('treats the last payment as the end of a completed agreement', async () => {
    // Paid off early on the 5th. The week still scheduled for the 12th was paid
    // in advance by that settlement, and must not count as fresh billing.
    const done = await agreement({ status: 'completed' });
    await schedule(done.id, await lastMonth(5), 800, { paid: 800, status: 'paid', week: 1 });
    await schedule(done.id, await lastMonth(12), 800, { paid: 800, status: 'paid', week: 2 });
    await payment(done, 800, await lastMonth(5));

    const m = month(await kpis(), prevMonthKey);
    expect(m.billed).toBe(800);
    expect(m.rate).toBe(100);
  });

  it('leaves out a defaulted agreement with no end date, and says how many', async () => {
    const running = await agreement({ status: 'active' });
    await schedule(running.id, await lastMonth(6), 1000, { paid: 1000, status: 'paid' });
    await payment(running, 1000, await lastMonth(6));

    // No end date means no honest cut-off, so it is excluded from both sides
    // rather than given a date nobody recorded.
    const defaulted = await agreement({ status: 'defaulted' });
    await schedule(defaulted.id, await lastMonth(6), 700, { status: 'overdue' });
    await payment(defaulted, 100, await lastMonth(6));

    const body = await kpis();
    expect(month(body, prevMonthKey)).toMatchObject({ billed: 1000, collected: 1000, rate: 100 });
    expect(body.collections.excluded_agreements).toBe(1);
  });

  it('keeps the current month out of the headline rate', async () => {
    const ag = await agreement({ status: 'active' });
    await schedule(ag.id, await lastMonth(6), 1000, { paid: 1000, status: 'paid', week: 1 });
    await payment(ag, 1000, await lastMonth(6));
    // Due today and not yet paid — still being collected, not a failure yet.
    await schedule(ag.id, await sqlDate('CURRENT_DATE'), 999, { week: 2 });

    const body = await kpis();
    expect(body.collections.months).toHaveLength(6);
    expect(body.collections.months.at(-1).billed).toBe(999);
    expect(body.collections.three_month.to).toBe(prevMonthKey);
    expect(body.collections.three_month.rate).toBe(100);
  });

  it('ages active arrears by the oldest unpaid week, and adds back up to the Overdue tile', async () => {
    const longBehind = await agreement({ status: 'active' });
    await schedule(longBehind.id, await daysAgo(100), 300, { status: 'overdue' });
    const recentlyBehind = await agreement({ status: 'active' });
    await schedule(recentlyBehind.id, await daysAgo(10), 200, { status: 'overdue' });
    await agreement({ status: 'active' });   // up to date
    const paused = await agreement({ status: 'paused' });
    await schedule(paused.id, await daysAgo(40), 50, { status: 'overdue' });

    const { arrears } = await kpis();
    const bucket = (key) => arrears.buckets.find((b) => b.key === key);
    expect(bucket('current')).toMatchObject({ agreements: 1 });
    expect(bucket('d1_30')).toMatchObject({ agreements: 1, amount: 200 });
    expect(bucket('d31_90')).toMatchObject({ agreements: 0, amount: 0 });
    expect(bucket('d90_plus')).toMatchObject({ agreements: 1, amount: 300 });
    expect(arrears).toMatchObject({ active_overdue: 500, other_overdue: 50, total_overdue: 550 });

    // The panel sits beside this tile. If the two ever stop reconciling, the
    // dashboard contradicts itself on screen.
    const dash = await request(app).get('/api/admin/dashboard').set(authHeader(admin));
    expect(dash.body.stats.overdue_amount).toBe(arrears.total_overdue);
  });

  it('counts losses and tracker coverage for platform bikes only', async () => {
    await createPgBike({ status: 'stolen' });
    await createPgBike({ status: 'written_off' });
    const tracked = await createPgBike({ status: 'active' });
    const untracked = await createPgBike({ status: 'active' });
    await agreement({ status: 'active', bike_id: tracked.id });
    await agreement({ status: 'active', bike_id: untracked.id });
    await pgDb.query(`INSERT INTO tracking_devices (imei, bike_id, last_seen_at) VALUES ('359000000000001', $1, NOW())`, [tracked.id]);

    // A fleet owner's own stolen bike is their loss, not the platform's.
    const org = await createPgOrg();
    await createPgBike({ status: 'stolen', organization_id: org.id });

    const { losses, trackers } = await kpis();
    expect(losses).toMatchObject({ fleet: 4, stolen: 1, written_off: 1, lost: 2, loss_rate: 50, lost_untracked: 2, priced: 0 });
    expect(trackers).toMatchObject({ on_road: 2, tracked: 1, reporting_24h: 1, coverage: 50 });
  });

  it('is not available to riders', async () => {
    const rider = (await createPgUser({ role: 'rider' })).user;
    const res = await request(app).get('/api/admin/kpis').set(authHeader(rider));
    expect(res.status).toBe(403);
  });
});
