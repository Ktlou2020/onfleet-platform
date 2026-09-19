import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement, createPgPaymentSchedule, createPgAlert, authHeader,
} from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const { collectDailyReport, renderDailyReport, sendDailyAdminReport } = require('../src/services/dailyAdminReport.js');
const app = buildApp();

// 08:00 in Johannesburg on Saturday 19 September 2026, so "yesterday" is Friday the 18th.
const NOW = new Date('2026-09-19T06:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

let seq = 0;
async function agreementWith({ weekly = 500, weeks = 10, due, paid = 0, paidAt = hoursAgo(72), status = 'active', name, plate } = {}) {
  const rider = (await createPgUser({ role: 'rider', full_name: name, phone: '0820000000' })).user;
  const bike = await createPgBike({ registration: plate });
  const ag = await createPgAgreement({ user_id: rider.id, bike_id: bike.id, weekly_amount: weekly, total_weeks: weeks, status });
  for (const [i, d] of due.entries()) {
    await createPgPaymentSchedule({ agreement_id: ag.id, week_number: i + 1, due_date: d, amount_due: weekly });
  }
  if (paid) {
    await pgDb.query(
      `INSERT INTO payments (agreement_id, user_id, amount, method, reference, status, paid_at)
       VALUES ($1,$2,$3,'eft',$4,'success',$5)`, [ag.id, rider.id, paid, `ref-${++seq}-${ag.id}`, paidAt]);
  }
  return ag;
}

describe.skipIf(!process.env.DATABASE_URL)('daily admin report', () => {
  beforeEach(resetAllPgTables);

  describe('missed payments', () => {
    it('lists riders who did not pay the instalment due yesterday', async () => {
      const missed = await agreementWith({ due: ['2026-09-11', '2026-09-18'], paid: 500, name: 'Missed Rider' });
      await agreementWith({ due: ['2026-09-11', '2026-09-18'], paid: 1000, name: 'Paid Rider' });
      const r = await collectDailyReport(NOW);
      expect(r.agreements.missed.map((a) => a.id)).toEqual([missed.id]);
      expect(r.agreements.missed[0]).toMatchObject({ arrears: 500, weeksBehind: 1 });
    });

    it('does not count a rider who paid late but before the report', async () => {
      await agreementWith({ due: ['2026-09-18'], paid: 500, paidAt: hoursAgo(1) });
      expect((await collectDailyReport(NOW)).agreements.missed).toHaveLength(0);
    });

    it('ignores riders whose instalment is due on another day, but still counts their arrears', async () => {
      const behind = await agreementWith({ due: ['2026-09-10', '2026-09-17'], paid: 0 });
      const r = await collectDailyReport(NOW);
      expect(r.agreements.missed).toHaveLength(0);
      expect(r.agreements.inArrears.map((a) => a.id)).toEqual([behind.id]);
      expect(r.agreements.arrearsTotal).toBe(1000);
    });

    it('ignores agreements that are no longer active', async () => {
      await agreementWith({ due: ['2026-09-18'], status: 'discontinued' });
      await agreementWith({ due: ['2026-09-18'], status: 'completed' });
      const r = await collectDailyReport(NOW);
      expect(r.agreements.missed).toHaveLength(0);
      expect(r.agreements.inArrears).toHaveLength(0);
    });

    it('does not bill waived weeks', async () => {
      const ag = await agreementWith({ due: [], paid: 0 });
      await createPgPaymentSchedule({ agreement_id: ag.id, week_number: 1, due_date: '2026-09-18', amount_due: 500, status: 'waived' });
      expect((await collectDailyReport(NOW)).agreements.missed).toHaveLength(0);
    });
  });

  describe('paying off soon', () => {
    it('lists riders with less than three weeks left and flags fully paid agreements still open', async () => {
      // 10 weeks x R500 = R5 000
      const close = await agreementWith({ due: ['2026-09-18'], paid: 4000 }); // 2 weeks left
      await agreementWith({ due: ['2026-09-18'], paid: 3500 });               // exactly 3 weeks left: not "less than"
      const done = await agreementWith({ due: ['2026-09-18'], paid: 5000 });
      const r = await collectDailyReport(NOW);
      expect(r.agreements.nearPayoff.map((a) => a.id)).toEqual([close.id]);
      expect(r.agreements.nearPayoff[0]).toMatchObject({ remaining: 1000, weeksLeft: 2 });
      expect(r.agreements.paidInFull.map((a) => a.id)).toEqual([done.id]);
    });
  });

  describe('tracking', () => {
    it('counts the last 24 hours of alarms by type and lists the serious ones', async () => {
      const bike = await createPgBike({ registration: 'LW78MDGP' });
      await createPgAlert({ bike_id: bike.id, alert_type: 'idle', created_at: hoursAgo(2) });
      await createPgAlert({ bike_id: bike.id, alert_type: 'idle', created_at: hoursAgo(3) });
      await createPgAlert({ bike_id: bike.id, alert_type: 'tamper', created_at: hoursAgo(4) });
      await createPgAlert({ bike_id: bike.id, alert_type: 'tamper', created_at: hoursAgo(30) }); // before the window
      await pgDb.query(`UPDATE tracking_alerts SET severity = CASE alert_type WHEN 'tamper' THEN 'critical' ELSE 'low' END`);
      const r = await collectDailyReport(NOW);
      expect(r.tracking.alerts.total).toBe(3);
      expect(r.tracking.alerts.types.map((t) => [t.type, t.count])).toEqual([['tamper', 1], ['idle', 2]]);
      expect(r.tracking.alerts.serious.map((a) => a.alert_type)).toEqual(['tamper']);
      expect(r.tracking.alerts.openCritical).toBe(2);
    });

    it('separates trackers that went silent from ones that never connected', async () => {
      const bike = await createPgBike({ registration: 'LJ89MWGP' });
      await pgDb.query(
        `INSERT INTO tracking_devices (imei, model, bike_id, last_seen_at) VALUES
           ('111111111111111', 'FMB920', NULL, $1), ('222222222222222', 'FMB920', NULL, $2), ('352592576608251', 'FMB920', $3, NULL)`,
        [hoursAgo(1), hoursAgo(50), bike.id]);
      const { devices } = (await collectDailyReport(NOW)).tracking;
      expect(devices.reporting).toBe(1);
      expect(devices.silent.map((d) => d.imei)).toEqual(['222222222222222']);
      expect(devices.neverConnected.map((d) => d.imei)).toEqual(['352592576608251']);
    });
  });

  it('escapes names in the email', async () => {
    await agreementWith({ due: ['2026-09-18'], name: '<img src=x onerror=alert(1)>' });
    const html = renderDailyReport(await collectDailyReport(NOW));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  describe('sending', () => {
    it('goes to every active admin and superadmin, once per day', async () => {
      await createPgUser({ role: 'admin', email: 'ops@example.test' });
      await createPgUser({ role: 'superadmin', email: 'boss@example.test' });
      await createPgUser({ role: 'admin', email: 'gone@example.test', status: 'suspended' });
      await createPgUser({ role: 'rider', email: 'rider@example.test' });
      const first = await sendDailyAdminReport({ now: NOW });
      expect(first.sent.sort()).toEqual(['boss@example.test', 'ops@example.test']);
      expect(await sendDailyAdminReport({ now: new Date(NOW.getTime() + 60_000) })).toMatchObject({ skipped: 'already sent today' });
      const nextDay = await sendDailyAdminReport({ now: new Date(NOW.getTime() + 24 * 3600 * 1000) });
      expect(nextDay.sent).toHaveLength(2);
    });

    it('lets a superadmin preview the report and send it only to themselves', async () => {
      const boss = (await createPgUser({ role: 'superadmin', email: 'boss@example.test' })).user;
      const admin = (await createPgUser({ role: 'admin', email: 'ops@example.test' })).user;
      const preview = await request(app).get('/api/admin/reports/daily/preview').set(authHeader(admin));
      expect(preview.status).toBe(200);
      expect(preview.text).toContain('Daily fleet report');
      expect((await request(app).post('/api/admin/reports/daily/send-to-me').set(authHeader(admin))).status).toBe(403);
      const res = await request(app).post('/api/admin/reports/daily/send-to-me').set(authHeader(boss));
      expect(res.body.sent).toEqual(['boss@example.test']);
      // A test send doesn't use up the day's real send
      expect((await sendDailyAdminReport({ now: new Date() })).sent).toHaveLength(2);
    });
  });
});
