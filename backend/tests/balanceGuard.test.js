import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike, createPgUser } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const { updateAgreementBalance } = load('../src/utils/helpersPg.js');
const { upsertAgreementFromFleetRow } = load('../src/services/csvImports.js');

// The guard that catches a mistyped remaining balance, and the hole it had.
//
// It compares the figure entered against the agreement's own contract value.
// That works while weekly_amount x total_weeks means something — but the fleet
// CSV importer used to set total_weeks to ceil(total_amount / weekly_amount),
// so a money error had already become a term. A balance of R472,703 on an
// R850 week produces a 556-week agreement, and against 556 weeks R472,703
// looks perfectly ordinary. The guard stopped firing on exactly the agreements
// that needed it.

const WEEKLY = 850;
const STANDARD_WEEKS = 78;

async function agreementWith({ totalWeeks, totalAmount, bikeWeeks = STANDARD_WEEKS }) {
  const bike = await createPgBike({ rental_weekly: WEEKLY });
  await pgDb.query('UPDATE bikes SET total_weeks = $1 WHERE id = $2', [bikeWeeks, bike.id]);
  const user = (await createPgUser({ role: 'rider' })).user;
  const { rows } = await pgDb.query(
    `INSERT INTO agreements (agreement_no, user_id, bike_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-01-05','2027-06-28','active') RETURNING *`,
    [`GUARD-${Date.now()}${Math.floor(Math.random() * 1000)}`, user.id, bike.id, WEEKLY, totalWeeks, totalAmount]);
  const agreement = rows[0];
  for (let w = 1; w <= totalWeeks; w++) {
    await pgDb.query(
      `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
       VALUES ($1,$2,$3,$4,0,'pending')`,
      [agreement.id, w, new Date(Date.UTC(2026, 0, 5 + (w - 1) * 7)).toISOString().slice(0, 10), WEEKLY]);
  }
  return agreement;
}

describe.skipIf(!process.env.DATABASE_URL)('a mistyped remaining balance', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('is refused on an ordinary agreement', async () => {
    const agreement = await agreementWith({ totalWeeks: STANDARD_WEEKS, totalAmount: WEEKLY * STANDARD_WEEKS });
    await expect(updateAgreementBalance(agreement.id, 472703.06)).rejects.toThrow(/more than 1.5x/);
  });

  // The hole. total_weeks is inflated the way the importer used to inflate it,
  // so the agreement's own arithmetic vouches for the bad figure.
  it('is still refused when the agreement\'s own term has been inflated to match', async () => {
    const agreement = await agreementWith({ totalWeeks: 556, totalAmount: 472703.06 });
    await expect(updateAgreementBalance(agreement.id, 472703.06)).rejects.toThrow(/more than 1.5x/);
  });

  it('measures against the bike\'s term, not the inflated one', async () => {
    const agreement = await agreementWith({ totalWeeks: 556, totalAmount: 472703.06 });
    // 78 weeks doubled x R850 = R132,600, so the message must quote 156 weeks
    // rather than the 556 the agreement claims.
    await expect(updateAgreementBalance(agreement.id, 472703.06)).rejects.toThrow(/156 weeks/);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a balance that is simply correct', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('is accepted on an ordinary agreement', async () => {
    const agreement = await agreementWith({ totalWeeks: STANDARD_WEEKS, totalAmount: WEEKLY * STANDARD_WEEKS });
    const result = await updateAgreementBalance(agreement.id, 43164.13);
    expect(result.remaining_balance).toBeCloseTo(43164.13, 2);
    expect(result.total_amount).toBeCloseTo(43164.13, 2);
  });

  // The ceiling doubles the bike's term, so an agreement that genuinely ran
  // long is not caught by a rule aimed at slipped digits.
  it('is accepted on an agreement that genuinely ran longer than its bike\'s term', async () => {
    const agreement = await agreementWith({ totalWeeks: 120, totalAmount: WEEKLY * 120 });
    const result = await updateAgreementBalance(agreement.id, WEEKLY * 110);
    expect(result.remaining_balance).toBeCloseTo(WEEKLY * 110, 2);
  });

  // A bike whose term is zero would make the reference zero, and a reference of
  // zero switches the guard off altogether rather than making it strict. The
  // standard term stands in so the check survives bad bike data.
  it('does not switch the guard off when the bike\'s term is zero', async () => {
    const agreement = await agreementWith({ totalWeeks: STANDARD_WEEKS, totalAmount: WEEKLY * STANDARD_WEEKS, bikeWeeks: 0 });
    await expect(updateAgreementBalance(agreement.id, 472703.06)).rejects.toThrow(/more than 1.5x/);
  });
});

// Where the inflated terms came from in the first place.
describe.skipIf(!process.env.DATABASE_URL)('importing a fleet row whose money is out by a digit', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  async function fleetRow(outstanding) {
    const bike = await createPgBike({ registration: 'MS23LDGP', rental_weekly: WEEKLY });
    await pgDb.query('UPDATE bikes SET total_weeks = $1 WHERE id = $2', [STANDARD_WEEKS, bike.id]);
    await createPgUser({ role: 'rider', full_name: 'Kazadi Zadio' });
    return {
      'Vehicle Reg': 'MS23LDGP',
      Driver: 'Kazadi Zadio',
      'Payment to be collected': String(WEEKLY),
      'Total Received From Flexclub': '23135.87',
      'Outstanding Balance': String(outstanding),
      'Date of bike hand over': '2026-02-04',
      STATUS: 'active',
    };
  }

  // The term used to be derived from the money, so this row wrote a 556-week
  // agreement and the balance guard had nothing left to measure against.
  it('is refused rather than written as a 556-week agreement', async () => {
    await expect(upsertAgreementFromFleetRow(await fleetRow(472703.06)))
      .rejects.toThrow(/this bike's term is 78 weeks/);
  });

  it('names both columns so the typo can be found', async () => {
    await expect(upsertAgreementFromFleetRow(await fleetRow(472703.06)))
      .rejects.toThrow(/Outstanding Balance|outstanding balance/);
  });

  it('writes nothing when it refuses', async () => {
    await upsertAgreementFromFleetRow(await fleetRow(472703.06)).catch(() => {});
    const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM agreements');
    expect(rows[0].n).toBe(0);
  });

  it('accepts the same row with the digit where it belongs', async () => {
    const agreement = await upsertAgreementFromFleetRow(await fleetRow(43164.13));
    expect(Number(agreement.total_amount)).toBeCloseTo(66300, 2);
    expect(Number(agreement.total_weeks)).toBe(78);
  });
});
