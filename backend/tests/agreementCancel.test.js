import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement, createPgPaymentSchedule, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// A test agreement on TestingGP could only be ended by defaulting it, which
// also put the fake bike back into the ready-to-go pool. Cancel is the way out
// for agreements that shouldn't exist.
describe.skipIf(!process.env.DATABASE_URL)('cancelling an agreement', () => {
  let admin;
  let bike;
  let agreement;
  const cancel = (body, user = admin, id = agreement.id) =>
    request(app).post(`/api/agreements/${id}/cancel`).set(authHeader(user)).send(body);
  const current = async () => (await pgDb.query(
    `SELECT a.status, a.notes, b.status AS bike_status FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = $1`,
    [agreement.id])).rows[0];

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    bike = await createPgBike({ registration: 'TestingGP', status: 'not_available' });
    agreement = await createPgAgreement({ bike_id: bike.id, weekly_amount: 500, total_weeks: 4, status: 'defaulted' });
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 1, due_date: '2026-09-04', amount_due: 500, amount_paid: 500, status: 'paid' });
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 2, due_date: '2026-09-11', amount_due: 500, amount_paid: 200, status: 'overdue' });
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 3, due_date: '2026-09-18', amount_due: 500, status: 'overdue' });
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 4, due_date: '2026-09-25', amount_due: 500, status: 'pending' });
  });

  it('cancels, waives unpaid weeks, keeps the bike status and records the reason', async () => {
    const res = await cancel({ reason: 'Test agreement, not a real rider' });
    expect(res.status).toBe(200);
    expect(res.body.waived_rows).toBe(3);
    const row = await current();
    expect(row).toMatchObject({ status: 'cancelled', bike_status: 'not_available' });
    expect(row.notes).toMatch(/Cancelled \d{4}-\d{2}-\d{2}: Test agreement, not a real rider/);
    const { rows: sched } = await pgDb.query('SELECT status FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number', [agreement.id]);
    expect(sched.map((s) => s.status)).toEqual(['paid', 'waived', 'waived', 'waived']);
    const { rows: [audit] } = await pgDb.query(`SELECT actor_id, metadata FROM audit_logs WHERE action = 'agreement.cancelled'`);
    expect(audit.actor_id).toBe(admin.id);
    expect(JSON.parse(audit.metadata)).toMatchObject({ previous_status: 'defaulted', reason: 'Test agreement, not a real rider', waived_rows: 3 });
  });

  it('requires a reason', async () => {
    expect((await cancel({})).status).toBe(400);
    expect((await cancel({ reason: '   ' })).status).toBe(400);
    expect((await current()).status).toBe('defaulted');
  });

  it('refuses agreements that have already ended', async () => {
    await pgDb.query(`UPDATE agreements SET status = 'completed' WHERE id = $1`, [agreement.id]);
    expect((await cancel({ reason: 'Test agreement' })).status).toBe(409);
    await pgDb.query(`UPDATE agreements SET status = 'cancelled' WHERE id = $1`, [agreement.id]);
    expect((await cancel({ reason: 'Test agreement' })).status).toBe(409);
  });

  it('is admin only', async () => {
    const rider = (await createPgUser({ role: 'rider' })).user;
    expect((await cancel({ reason: 'Test agreement' }, rider)).status).toBe(403);
    expect((await current()).status).toBe('defaulted');
  });
});
