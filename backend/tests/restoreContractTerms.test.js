import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgAgreement } from './helpers/testPgDb.js';

const repair = createRequire(import.meta.url)('../src/scripts/restore-contract-terms.js');

// Putting an agreement's money back to what its contract says.
//
// A remaining balance typed by hand is re-spread over the open weeks and the
// agreement's total becomes "paid so far, plus the figure entered". A slipped
// digit therefore rewrites the contract: a R66,300 bike stored R495,838.93,
// billed R6,087.27 a week, and showed its rider six figures in arrears. The
// repair is not a better guess at the balance — it is total_weeks instalments
// of weekly_amount, the two numbers the corruption never touched, with every
// payment replayed against them.

const WEEKLY = 850;
const WEEKS = 78;
const FACE = WEEKLY * WEEKS; // 66,300

/** An agreement damaged the way the live one was: total = paid + a bad balance. */
async function damagedAgreement({ paid = 0, storedTotal = 495838.93, status = 'active' } = {}) {
  const agreement = await createPgAgreement({
    agreement_no: `LEG-TEST-${Date.now()}${Math.floor(Math.random() * 1000)}`,
    weekly_amount: WEEKLY, total_weeks: WEEKS, total_amount: storedTotal, status,
  });
  // The re-spread schedule: every open week billing far more than the contract.
  const perWeek = +(storedTotal / WEEKS).toFixed(2);
  for (let w = 1; w <= WEEKS; w++) {
    await pgDb.query(
      `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
       VALUES ($1,$2,$3,$4,0,'pending')`,
      [agreement.id, w, new Date(Date.UTC(2026, 0, 5 + (w - 1) * 7)).toISOString().slice(0, 10), perWeek]);
  }
  if (paid > 0) {
    await pgDb.query(
      `INSERT INTO payments (agreement_id, user_id, amount, status, method, reference, paid_at)
       VALUES ($1,$2,$3,'success','eft','TEST-PAY',CURRENT_TIMESTAMP)`,
      [agreement.id, agreement.user_id, paid]);
  }
  return agreement;
}

const scheduleOf = async (id) =>
  (await pgDb.query(
    `SELECT week_number, amount_due, amount_paid, status FROM payment_schedules
      WHERE agreement_id = $1 ORDER BY week_number ASC`, [id])).rows;

const totalOf = async (id) =>
  Number((await pgDb.query('SELECT total_amount FROM agreements WHERE id = $1', [id])).rows[0].total_amount);

describe.skipIf(!process.env.DATABASE_URL)('restoring an agreement to its contract terms', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('puts the total back to the contract\'s own face value', async () => {
    const agreement = await damagedAgreement({ paid: 23135.87 });
    await repair.restore(agreement, FACE);
    expect(await totalOf(agreement.id)).toBeCloseTo(FACE, 2);
  });

  it('bills the agreement\'s own weekly amount again', async () => {
    const agreement = await damagedAgreement({ paid: 23135.87 });
    await repair.restore(agreement, FACE);
    const rows = await scheduleOf(agreement.id);
    expect(rows).toHaveLength(WEEKS);
    // Every week but the last is the contract's weekly amount; the last settles
    // the remainder, which here divides exactly.
    for (const row of rows) expect(Number(row.amount_due)).toBeCloseTo(WEEKLY, 2);
  });

  it('leaves the rider owing the contract less what they have paid', async () => {
    const agreement = await damagedAgreement({ paid: 23135.87 });
    await repair.restore(agreement, FACE);
    const rows = await scheduleOf(agreement.id);
    const outstanding = rows.reduce((sum, r) => sum + Math.max(Number(r.amount_due) - Number(r.amount_paid), 0), 0);
    expect(outstanding).toBeCloseTo(FACE - 23135.87, 2);
  });

  it('replays the payments across the weeks instead of discarding them', async () => {
    const agreement = await damagedAgreement({ paid: 23135.87 });
    await repair.restore(agreement, FACE);
    const rows = await scheduleOf(agreement.id);
    const paidWeeks = rows.filter((r) => r.status === 'paid');
    // R23,135.87 covers 27 whole weeks of R850 with R185.87 left over.
    expect(paidWeeks).toHaveLength(27);
    expect(Number(rows[27].amount_paid)).toBeCloseTo(185.87, 2);
  });

  it('never touches the payments themselves', async () => {
    const agreement = await damagedAgreement({ paid: 23135.87 });
    const before = (await pgDb.query('SELECT id, amount FROM payments WHERE agreement_id = $1', [agreement.id])).rows;
    await repair.restore(agreement, FACE);
    const after = (await pgDb.query('SELECT id, amount FROM payments WHERE agreement_id = $1', [agreement.id])).rows;
    expect(after).toEqual(before);
  });

  // Waiving a week is a decision about one rider in one week. The schedule is
  // rebuilt from nothing, so it has to be carried across deliberately.
  it('keeps a waived week waived', async () => {
    const agreement = await damagedAgreement({ paid: 0 });
    await pgDb.query(
      `UPDATE payment_schedules SET status = 'waived' WHERE agreement_id = $1 AND week_number = 9`, [agreement.id]);
    await repair.restore(agreement, FACE);
    const rows = await scheduleOf(agreement.id);
    expect(rows.find((r) => r.week_number === 9).status).toBe('waived');
    expect(rows.filter((r) => r.status === 'waived')).toHaveLength(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('which agreements it will touch', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('finds one storing far more than its own contract is worth', async () => {
    const agreement = await damagedAgreement();
    const found = await repair.candidates({ agreementNo: null });
    expect(found.map((r) => r.id)).toContain(agreement.id);
  });

  // An adjustment inside the threshold may well be deliberate — arrears, fees,
  // a settlement — and this script has no standing to overwrite a human's
  // decision about what somebody owes.
  it('leaves a modest adjustment alone', async () => {
    const agreement = await damagedAgreement({ storedTotal: FACE * 1.2 });
    const found = await repair.candidates({ agreementNo: null });
    expect(found.map((r) => r.id)).not.toContain(agreement.id);
  });

  it('finds one by number even when it is not damaged', async () => {
    const agreement = await createPgAgreement({ agreement_no: 'LEG-BY-NUMBER', total_amount: FACE });
    const found = await repair.candidates({ agreementNo: 'LEG-BY-NUMBER' });
    expect(found.map((r) => r.id)).toEqual([agreement.id]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('what it refuses to do on its own', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('will not rewrite a completed agreement', async () => {
    const agreement = await damagedAgreement({ status: 'completed' });
    expect(repair.refusalFor(agreement, FACE, 0)).toMatch(/status is completed/);
  });

  // Either the payments or the terms are wrong, and choosing between them
  // would be a guess about somebody's money.
  it('will not repair a rider who has paid more than the contract is worth', async () => {
    const agreement = await damagedAgreement();
    expect(repair.refusalFor(agreement, FACE, FACE + 100)).toMatch(/exceed the contract/);
  });

  it('will not repair an agreement with no face value to restore to', async () => {
    const agreement = await damagedAgreement();
    expect(repair.refusalFor({ ...agreement, weekly_amount: 0 }, 0, 0)).toMatch(/no face value/);
  });

  it('repairs an ordinary damaged active agreement', async () => {
    const agreement = await damagedAgreement();
    expect(repair.refusalFor(agreement, FACE, 23135.87)).toBeNull();
  });
});

// The way this corruption hides from its own detector.
//
// The importer used to set total_weeks to ceil(total_amount / weekly_amount),
// so on a damaged agreement the face value is inflated in step with the total
// and the ratio between them comes out near 1. Measured against its own
// inflated term, 556 weeks x R850 = R472,600 against a R495,838 total is 1.05
// — nowhere near the 1.5x threshold. Capping the term at the bike's is what
// makes it visible again.
describe.skipIf(!process.env.DATABASE_URL)('an agreement whose term was inflated too', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  async function inflatedTermAgreement() {
    const agreement = await createPgAgreement({
      agreement_no: `LEG-INFLATED-${Date.now()}`,
      weekly_amount: WEEKLY, total_weeks: 556, total_amount: 495838.93,
    });
    await pgDb.query('UPDATE bikes SET total_weeks = $1 WHERE id = $2', [WEEKS, agreement.bike_id]);
    const { rows } = await pgDb.query(
      `SELECT a.*, b.total_weeks AS bike_total_weeks FROM agreements a
         LEFT JOIN bikes b ON b.id = a.bike_id WHERE a.id = $1`, [agreement.id]);
    return rows[0];
  }

  it('is found, even though its own face value vouches for it', async () => {
    const agreement = await inflatedTermAgreement();
    const found = await repair.candidates({ agreementNo: null });
    expect(found.map((r) => r.id)).toContain(agreement.id);
  });

  // Restoring 556 x R850 would hand the rider a R472,600 contract and call it
  // repaired. The term is as suspect as the total.
  it('is reported but never repaired, because its term is suspect too', async () => {
    const agreement = await inflatedTermAgreement();
    const refusal = repair.refusalFor(agreement, WEEKLY * 556, 23135.87);
    expect(refusal).toMatch(/term of 556 weeks is more than twice/);
  });

  it('still repairs an agreement whose term is sane', async () => {
    const agreement = await damagedAgreement();
    const { rows } = await pgDb.query(
      `SELECT a.*, b.total_weeks AS bike_total_weeks FROM agreements a
         LEFT JOIN bikes b ON b.id = a.bike_id WHERE a.id = $1`, [agreement.id]);
    expect(repair.refusalFor(rows[0], FACE, 23135.87)).toBeNull();
  });
});
