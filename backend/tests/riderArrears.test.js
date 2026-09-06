import { describe, it, expect, beforeEach } from 'vitest';
import { shouldSendOverdueToday } from '../src/services/scheduler.js';
import { buildPaymentSchedule } from '../src/utils/helpersPg.js';
import { pgDb, resetAllPgTables, createPgAgreement } from './helpers/testPgDb.js';

// Two riders were being chased for money they did not owe, and every rider in
// arrears was being chased daily without end. Both come back to the schedule
// being treated as an independent source of truth rather than a view of the
// contract.

describe('overdue notice cadence', () => {
  const sent = (days) => days.filter(shouldSendOverdueToday);

  it('sends daily through the first week, when a rider may have simply missed one', () => {
    expect(sent([1, 2, 3, 4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('eases to every third day for the rest of the first month', () => {
    expect(sent([8, 9, 10, 11, 12, 13, 14, 15])).toEqual([9, 12, 15]);
  });

  it('drops to weekly once the debt is over a month old', () => {
    expect(sent([31, 32, 33, 34, 35, 36, 37, 38, 42, 49])).toEqual([35, 42, 49]);
  });

  it('turns 118 days of daily chasing into 27 messages', () => {
    // 118 consecutive days is what riders actually received, 9 May to 5 Sep.
    const everyDay = Array.from({ length: 118 }, (_, i) => i + 1);
    expect(sent(everyDay)).toHaveLength(27);     // 7 daily + 8 every-third-day + 12 weekly
  });
});

describe.skipIf(!process.env.DATABASE_URL)('buildPaymentSchedule reconciles to the contract total', () => {
  const makeAgreement = async ({ weekly, weeks, total }) =>
    (await createPgAgreement({ weekly_amount: weekly, total_weeks: weeks, total_amount: total })).id;
  const scheduleOf = async (id) => {
    const { rows } = await pgDb.query(
      'SELECT week_number, amount_due FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number', [id]);
    return rows.map((r) => ({ week: r.week_number, due: Number(r.amount_due) }));
  };

  beforeEach(async () => {
    await resetAllPgTables();
  });

  it('settles the remainder on the final week instead of overshooting', async () => {
    // Exactly the shape that left one rider permanently overdue on a bike he
    // had already paid off: 81 x R800 = R64,800 against a R64,190.20 contract.
    const id = await makeAgreement({ weekly: 800, weeks: 81, total: 64190.20 });
    await buildPaymentSchedule(id, 800, 81, '2026-01-05');

    const rows = await scheduleOf(id);
    expect(rows).toHaveLength(81);
    expect(rows.slice(0, 80).every((r) => r.due === 800)).toBe(true);
    expect(rows[80].due).toBe(190.20);
    expect(+rows.reduce((s, r) => s + r.due, 0).toFixed(2)).toBe(64190.20);
  });

  it('leaves an exact contract completely alone', async () => {
    const id = await makeAgreement({ weekly: 850, weeks: 4, total: 3400 });
    await buildPaymentSchedule(id, 850, 4, '2026-01-05');

    const rows = await scheduleOf(id);
    expect(rows.every((r) => r.due === 850)).toBe(true);
    expect(+rows.reduce((s, r) => s + r.due, 0).toFixed(2)).toBe(3400);
  });

  it('refuses to reshape when the term length itself is wrong, rather than burying it', async () => {
    // 78 weeks at R850 is R66,300, but the contract says R64,600 — the term is
    // two weeks too long. That is not a rounding remainder, and quietly
    // shrinking a week would hide a real disagreement about the contract.
    const id = await makeAgreement({ weekly: 850, weeks: 78, total: 64600 });
    await buildPaymentSchedule(id, 850, 78, '2026-01-05');

    const rows = await scheduleOf(id);
    expect(rows.every((r) => r.due === 850)).toBe(true);
  });

  it('does not leave a final week the rider can never clear', async () => {
    const id = await makeAgreement({ weekly: 800, weeks: 81, total: 64190.20 });
    await buildPaymentSchedule(id, 800, 81, '2026-01-05');

    // Pay the contract off in full, then confirm nothing is still outstanding.
    const { rows: agreementRows } = await pgDb.query('SELECT total_amount FROM agreements WHERE id = $1', [id]);
    const { rows } = await pgDb.query(
      `SELECT SUM(amount_due) AS scheduled FROM payment_schedules WHERE agreement_id = $1`, [id]);
    expect(Number(rows[0].scheduled)).toBe(Number(agreementRows[0].total_amount));
  });
});
