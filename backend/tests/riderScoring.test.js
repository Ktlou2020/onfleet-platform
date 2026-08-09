import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetAllPgTables, createPgUser, createPgBike, createPgAgreement,
  createPgPaymentSchedule, createPgAlert,
} from './helpers/testPgDb.js';
import { scoreRiders } from '../src/services/riderScoring.js';

describe.skipIf(!process.env.DATABASE_URL)('scoreRiders', () => {
  let bike, agreement, riderUser;

  beforeEach(async () => {
    await resetAllPgTables();
    bike = await createPgBike();
    agreement = await createPgAgreement({ bike_id: bike.id });
    const { user } = await createPgUser({ role: 'rider', address_match_status: 'unverified' });
    riderUser = user;
  });

  function riderRow(overrides = {}) {
    return {
      user_id: riderUser.id, full_name: riderUser.full_name, phone: riderUser.phone,
      address_match_status: 'unverified', agreement_id: agreement.id, bike_id: bike.id,
      bike_registration: bike.registration,
      ...overrides,
    };
  }

  it('gives a clean rider (no alerts, no payment history, no mismatch) a score of 100', async () => {
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.score).toBe(100);
    expect(scored.critical_alerts_90d).toBe(0);
    expect(scored.driving_alerts_90d).toBe(0);
  });

  it('subtracts 12 points per critical alert in the last 90 days, up to a cap of 5', async () => {
    await createPgAlert({ bike_id: bike.id, alert_type: 'towing' });
    await createPgAlert({ bike_id: bike.id, alert_type: 'night_movement' });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.critical_alerts_90d).toBe(2);
    expect(scored.score).toBe(100 - 2 * 12);
  });

  it('caps the critical-alert penalty at 5 alerts (60 points), not more', async () => {
    for (let i = 0; i < 8; i++) await createPgAlert({ bike_id: bike.id, alert_type: 'towing' });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.critical_alerts_90d).toBe(8); // raw count still reported...
    expect(scored.score).toBe(100 - 5 * 12); // ...but the penalty caps at 5
  });

  it('subtracts 2 points per driving-behavior alert, up to a cap of 10', async () => {
    await createPgAlert({ bike_id: bike.id, alert_type: 'speeding' });
    await createPgAlert({ bike_id: bike.id, alert_type: 'harsh_brake' });
    await createPgAlert({ bike_id: bike.id, alert_type: 'harsh_cornering' });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.driving_alerts_90d).toBe(3);
    expect(scored.score).toBe(100 - 3 * 2);
  });

  it('ignores alerts older than 90 days', async () => {
    await createPgAlert({ bike_id: bike.id, alert_type: 'towing', created_at: new Date(Date.now() - 91 * 86400000).toISOString() });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.critical_alerts_90d).toBe(0);
    expect(scored.score).toBe(100);
  });

  it('penalizes overdue/late payments proportionally, up to 30 points', async () => {
    // 1 overdue out of 6 reckoned schedules -> 30 * (1/6) = 5 point penalty
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 1, status: 'overdue', due_date: '2026-01-05' });
    for (let w = 2; w <= 6; w++) {
      await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: w, status: 'paid', amount_paid: 850, due_date: '2026-01-05', paid_at: '2026-01-04T00:00:00Z' });
    }
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.payment_reckoned).toBe(6);
    expect(scored.payment_late_or_overdue).toBe(1);
    expect(scored.score).toBe(100 - 5);
  });

  it('counts a "paid" schedule as late if paid_at is after due_date', async () => {
    await createPgPaymentSchedule({
      agreement_id: agreement.id, week_number: 1, status: 'paid', amount_paid: 850,
      due_date: '2026-01-05', paid_at: '2026-01-10T00:00:00Z', // paid 5 days late
    });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.payment_reckoned).toBe(1);
    expect(scored.payment_late_or_overdue).toBe(1);
    expect(scored.score).toBe(100 - 30); // 1/1 late = full 30-point penalty
  });

  it('does not penalize pending or waived schedules (not yet due, or forgiven)', async () => {
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 1, status: 'pending', due_date: '2099-01-05' });
    await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: 2, status: 'waived', due_date: '2026-01-12' });
    const [scored] = await scoreRiders([riderRow()]);
    expect(scored.payment_reckoned).toBe(0);
    expect(scored.score).toBe(100);
  });

  it('subtracts 10 points for an address mismatch', async () => {
    const [scored] = await scoreRiders([riderRow({ address_match_status: 'mismatch' })]);
    expect(scored.score).toBe(90);
  });

  it('does not penalize an unverified or matched address', async () => {
    expect((await scoreRiders([riderRow({ address_match_status: 'match' })]))[0].score).toBe(100);
    expect((await scoreRiders([riderRow({ address_match_status: 'unverified' })]))[0].score).toBe(100);
  });

  it('combines all penalty factors and floors at 0', async () => {
    for (let i = 0; i < 6; i++) await createPgAlert({ bike_id: bike.id, alert_type: 'panic' }); // caps at 5*12=60
    for (let i = 0; i < 12; i++) await createPgAlert({ bike_id: bike.id, alert_type: 'speeding' }); // caps at 10*2=20
    for (let w = 1; w <= 5; w++) {
      await createPgPaymentSchedule({ agreement_id: agreement.id, week_number: w, status: 'overdue', due_date: `2026-01-0${w}` });
    }
    const [scored] = await scoreRiders([riderRow({ address_match_status: 'mismatch' })]);
    // 60 + 20 + 30 (fully overdue) + 10 = 120 penalty against a 100 base -> floors at 0
    expect(scored.score).toBe(0);
  });

  it('scores multiple riders independently in one call', async () => {
    const { user: rider2 } = await createPgUser({ role: 'rider' });
    const bike2 = await createPgBike();
    const agreement2 = await createPgAgreement({ bike_id: bike2.id, user_id: rider2.id });
    await createPgAlert({ bike_id: bike.id, alert_type: 'towing' }); // only affects rider 1

    const results = await scoreRiders([
      riderRow(),
      { user_id: rider2.id, full_name: rider2.full_name, phone: rider2.phone, address_match_status: 'unverified', agreement_id: agreement2.id, bike_id: bike2.id, bike_registration: bike2.registration },
    ]);

    const scoreByUser = Object.fromEntries(results.map((r) => [r.user_id, r.score]));
    expect(scoreByUser[riderUser.id]).toBe(100 - 12);
    expect(scoreByUser[rider2.id]).toBe(100);
  });
});
