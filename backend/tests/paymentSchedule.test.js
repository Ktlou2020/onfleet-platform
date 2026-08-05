import { describe, it, expect, beforeEach } from 'vitest';
import { buildPaymentSchedule, recalcScheduleStatuses, rebuildScheduleAllocations } from '../src/utils/helpers.js';
import { db, resetAllTables, createAgreement, createPayment } from './helpers/testDb.js';

beforeEach(() => {
  resetAllTables();
});

describe('buildPaymentSchedule', () => {
  it('creates one row per week, 7 days apart, each for the weekly amount', () => {
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 4, start_date: '2026-01-05' });
    buildPaymentSchedule(agreement.id, 850, 4, '2026-01-05');

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.week_number)).toEqual([1, 2, 3, 4]);
    expect(rows.map(r => r.due_date)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
    expect(rows.every(r => r.amount_due === 850)).toBe(true);
    expect(rows.every(r => r.amount_paid === 0 && r.status === 'pending')).toBe(true);
  });
});

describe('recalcScheduleStatuses', () => {
  it('marks a fully-paid week as paid', () => {
    const agreement = createAgreement();
    buildPaymentSchedule(agreement.id, 850, 1, '2026-01-05');
    const row = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ?').get(agreement.id);
    db.prepare('UPDATE payment_schedules SET amount_paid = ? WHERE id = ?').run(850, row.id);

    recalcScheduleStatuses(agreement.id);

    expect(db.prepare('SELECT status FROM payment_schedules WHERE id = ?').get(row.id).status).toBe('paid');
  });

  it('marks an unpaid past-due week as overdue', () => {
    const agreement = createAgreement();
    buildPaymentSchedule(agreement.id, 850, 1, '2020-01-05'); // long past

    recalcScheduleStatuses(agreement.id);

    const row = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ?').get(agreement.id);
    expect(row.status).toBe('overdue');
  });

  it('marks a partially-paid past-due week as overdue, not partial', () => {
    const agreement = createAgreement();
    buildPaymentSchedule(agreement.id, 850, 1, '2020-01-05');
    const row = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ?').get(agreement.id);
    db.prepare('UPDATE payment_schedules SET amount_paid = ? WHERE id = ?').run(300, row.id);

    recalcScheduleStatuses(agreement.id);

    expect(db.prepare('SELECT status FROM payment_schedules WHERE id = ?').get(row.id).status).toBe('overdue');
  });

  it('leaves an unpaid future week as pending', () => {
    const agreement = createAgreement();
    const farFuture = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    buildPaymentSchedule(agreement.id, 850, 1, farFuture);

    recalcScheduleStatuses(agreement.id);

    const row = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ?').get(agreement.id);
    expect(row.status).toBe('pending');
  });

  it('never changes a waived week', () => {
    const agreement = createAgreement();
    buildPaymentSchedule(agreement.id, 850, 1, '2020-01-05');
    const row = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ?').get(agreement.id);
    db.prepare(`UPDATE payment_schedules SET status = 'waived' WHERE id = ?`).run(row.id);

    recalcScheduleStatuses(agreement.id);

    expect(db.prepare('SELECT status FROM payment_schedules WHERE id = ?').get(row.id).status).toBe('waived');
  });
});

describe('rebuildScheduleAllocations — cascades payments to the oldest unpaid week first', () => {
  it('applies a single payment covering exactly one week', () => {
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 3, start_date: '2020-01-05' });
    buildPaymentSchedule(agreement.id, 850, 3, '2020-01-05');
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 850 });

    rebuildScheduleAllocations(agreement.id);

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].amount_paid).toBe(850);
    expect(rows[1].status).toBe('overdue'); // still unpaid and past due
    expect(rows[1].amount_paid).toBe(0);
    expect(rows[2].amount_paid).toBe(0);
  });

  it('spills a payment larger than one week into the next unpaid week', () => {
    // Future-dated schedule so the partially-paid week is "partial", not "overdue"
    // (rebuildScheduleAllocations correctly reclassifies a partial past-due week as
    // overdue — covered separately above — which would otherwise muddy this test).
    const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 3, start_date: future });
    buildPaymentSchedule(agreement.id, 850, 3, future);
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 1200 }); // 850 + 350

    rebuildScheduleAllocations(agreement.id);

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    expect(rows[0].status).toBe('paid');
    expect(rows[0].amount_paid).toBe(850);
    expect(rows[1].status).toBe('partial');
    expect(rows[1].amount_paid).toBe(350);
    expect(rows[2].amount_paid).toBe(0);
  });

  it('applies multiple payments in chronological order, oldest week first', () => {
    const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 3, start_date: future });
    buildPaymentSchedule(agreement.id, 850, 3, future);
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 500, paid_at: '2026-01-06T00:00:00.000Z' });
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 500, paid_at: '2026-01-07T00:00:00.000Z' });

    rebuildScheduleAllocations(agreement.id);

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    // 500 + 500 = 1000: week 1 (850) fully paid, week 2 gets the remaining 150
    expect(rows[0].status).toBe('paid');
    expect(rows[0].amount_paid).toBe(850);
    expect(rows[1].status).toBe('partial');
    expect(rows[1].amount_paid).toBe(150);
  });

  it('skips waived weeks entirely when allocating', () => {
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 3, start_date: '2020-01-05' });
    buildPaymentSchedule(agreement.id, 850, 3, '2020-01-05');
    const week1 = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? AND week_number = 1').get(agreement.id);
    db.prepare(`UPDATE payment_schedules SET status = 'waived' WHERE id = ?`).run(week1.id);
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 850 });

    rebuildScheduleAllocations(agreement.id);

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    expect(rows[0].status).toBe('waived');
    expect(rows[0].amount_paid).toBe(0); // untouched
    expect(rows[1].status).toBe('paid'); // payment skipped week 1, applied to week 2 instead
    expect(rows[1].amount_paid).toBe(850);
  });

  it('ignores failed/pending payments, only allocates successful ones', () => {
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 2, start_date: '2020-01-05' });
    buildPaymentSchedule(agreement.id, 850, 2, '2020-01-05');
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 850, status: 'failed' });
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 850, status: 'pending' });

    rebuildScheduleAllocations(agreement.id);

    const rows = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    expect(rows.every(r => r.amount_paid === 0)).toBe(true);
  });

  it('is idempotent — rebuilding twice from the same payments gives the same result', () => {
    const agreement = createAgreement({ weekly_amount: 850, total_weeks: 3, start_date: '2020-01-05' });
    buildPaymentSchedule(agreement.id, 850, 3, '2020-01-05');
    createPayment({ agreement_id: agreement.id, user_id: agreement.user_id, amount: 1000 });

    rebuildScheduleAllocations(agreement.id);
    const first = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);
    rebuildScheduleAllocations(agreement.id);
    const second = db.prepare('SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number').all(agreement.id);

    expect(second).toEqual(first);
  });
});
