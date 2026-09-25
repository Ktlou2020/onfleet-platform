'use strict';

// Put an agreement's money back to what its own contract says.
//
// A remaining balance typed in by hand is re-spread across the open weeks, and
// the agreement's total_amount becomes "what has been paid, plus the figure
// just entered". Enter a balance with a slipped digit and the contract total
// follows it: one agreement for a R66,300 bike — 78 weeks at R850 — ended up
// storing R495,838.93, billing R6,087.27 a week, and showing its rider more
// than R100,000 in arrears. helpersPg.js has guarded against that since 6
// September 2026, so nothing new lands in this state, but the agreements
// damaged beforehand were never repaired.
//
// The repair is not a better guess at the balance. It is the contract:
// total_weeks instalments of weekly_amount, which are the two figures the
// corruption never touched, with the final week settling the remainder as
// buildPaymentSchedule always does. Every payment is then replayed against
// that schedule in order, so what the rider has actually paid decides what is
// left rather than anything typed in.
//
//   node src/scripts/restore-contract-terms.js                      # dry run, all damaged
//   node src/scripts/restore-contract-terms.js --agreement LEG-...   # dry run, just that one
//   node src/scripts/restore-contract-terms.js --apply               # write
//
// Nothing is written without --apply. The payments table is never touched by
// either mode: the schedule is derived from it, never the other way round.

const pgDb = require('../pgDb');
const {
  logAudit,
  buildPaymentSchedule,
  rebuildScheduleAllocations,
  recalcScheduleStatuses,
} = require('../utils/helpersPg');

// The same multiple updateAgreementBalance refuses to accept. An agreement
// whose stored total is inside it may well have been adjusted on purpose —
// arrears, fees, a settlement — and that is a human decision this script has
// no standing to overwrite.
const DAMAGE_THRESHOLD = 1.5;

// Rewriting the schedule of an agreement nobody is paying any more is a
// different and riskier act than fixing a live one.
const REPAIRABLE_STATUSES = ['active', 'paused', 'defaulted'];

const money = (n) => `R${Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

function parseArgs(argv) {
  const args = { apply: false, agreement: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--agreement') args.agreement = argv[++i];
    else if (argv[i].startsWith('--agreement=')) args.agreement = argv[i].slice('--agreement='.length);
  }
  return args;
}

async function candidates({ agreementNo }) {
  if (agreementNo) {
    const { rows } = await pgDb.query(
      `SELECT a.*, u.full_name FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.agreement_no = $1`,
      [agreementNo]);
    return rows;
  }
  const { rows } = await pgDb.query(
    `SELECT a.*, u.full_name
       FROM agreements a JOIN users u ON u.id = a.user_id
      WHERE a.weekly_amount > 0 AND a.total_weeks > 0
        AND a.total_amount > a.weekly_amount * a.total_weeks * $1
      ORDER BY a.total_amount / (a.weekly_amount * a.total_weeks) DESC`,
    [DAMAGE_THRESHOLD]);
  return rows;
}

async function paidTotalFor(agreementId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount, 0), amount)), 0) AS total
       FROM payments WHERE agreement_id = $1 AND status = 'success'`, [agreementId]);
  return Number(rows[0].total || 0);
}

async function currentInstalment(agreementId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT amount_due FROM payment_schedules
      WHERE agreement_id = $1 AND status NOT IN ('paid', 'waived')
      ORDER BY week_number ASC LIMIT 1`, [agreementId]);
  return rows.length ? Number(rows[0].amount_due) : null;
}

/** Why this agreement cannot be repaired mechanically, or null when it can. */
function refusalFor(agreement, faceValue, paidTotal) {
  if (!REPAIRABLE_STATUSES.includes(agreement.status)) {
    return `status is ${agreement.status} — only ${REPAIRABLE_STATUSES.join(', ')} are repaired here`;
  }
  if (!(faceValue > 0)) {
    return 'weekly amount or term is missing, so the contract has no face value to restore to';
  }
  // The rider has paid more than the contract is worth. Either the payments or
  // the terms are wrong, and picking one would be a guess about somebody's
  // money.
  if (paidTotal > faceValue + 0.01) {
    return `payments received (${money(paidTotal)}) exceed the contract's face value (${money(faceValue)}) — needs a person`;
  }
  return null;
}

async function restore(agreement, faceValue) {
  // Waiving a week is a decision somebody made about a particular rider in a
  // particular week. The schedule is rebuilt from scratch below, so those weeks
  // are noted first and put back afterwards.
  const { rows: waivedRows } = await pgDb.query(
    `SELECT week_number FROM payment_schedules WHERE agreement_id = $1 AND status = 'waived'`,
    [agreement.id]);
  const waived = waivedRows.map((r) => Number(r.week_number));

  await pgDb.withTransaction(async (client) => {
    // Before the rebuild, not after: buildPaymentSchedule reads total_amount to
    // work out the final instalment, so it has to be the restored figure.
    await client.query(
      'UPDATE agreements SET total_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [faceValue, agreement.id]);
    await client.query('DELETE FROM payment_schedules WHERE agreement_id = $1', [agreement.id]);
    await buildPaymentSchedule(
      agreement.id, Number(agreement.weekly_amount), Number(agreement.total_weeks), agreement.start_date, client);
    if (waived.length) {
      await client.query(
        `UPDATE payment_schedules SET status = 'waived' WHERE agreement_id = $1 AND week_number = ANY($2)`,
        [agreement.id, waived]);
    }
    // Replays every successful payment against the new rows, oldest week
    // first, which is what decides the remaining balance.
    await rebuildScheduleAllocations(agreement.id, client);
    await recalcScheduleStatuses(agreement.id, client);
  });

  return { waivedPreserved: waived.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await candidates({ agreementNo: args.agreement });

  if (!rows.length) {
    console.log(args.agreement
      ? `No agreement found with number ${args.agreement}.`
      : `No agreement stores a total more than ${DAMAGE_THRESHOLD}x its own face value. Nothing to repair.`);
    return;
  }

  console.log(args.apply ? '\nAPPLYING — writing changes.\n' : '\nDRY RUN — nothing will be written. Add --apply to write.\n');

  let repaired = 0;
  let refused = 0;

  for (const agreement of rows) {
    const weekly = Number(agreement.weekly_amount);
    const weeks = Number(agreement.total_weeks);
    const faceValue = +(weekly * weeks).toFixed(2);
    const paidTotal = await paidTotalFor(agreement.id);
    const instalmentBefore = await currentInstalment(agreement.id);

    console.log(`${agreement.agreement_no}  ·  ${agreement.full_name}  ·  ${agreement.status}`);
    console.log(`    contract     ${weeks} weeks x ${money(weekly)}`);
    console.log(`    total        ${money(agreement.total_amount)}  ->  ${money(faceValue)}`);
    console.log(`    received     ${money(paidTotal)}`);
    console.log(`    remaining    ${money(Number(agreement.total_amount) - paidTotal)}  ->  ${money(faceValue - paidTotal)}`);
    if (instalmentBefore != null) {
      console.log(`    instalment   ${money(instalmentBefore)}  ->  ${money(weekly)} (final week settles the remainder)`);
    }

    const refusal = refusalFor(agreement, faceValue, paidTotal);
    if (refusal) {
      console.log(`    SKIPPED      ${refusal}\n`);
      refused++;
      continue;
    }

    if (!args.apply) {
      console.log('    would repair\n');
      repaired++;
      continue;
    }

    const { waivedPreserved } = await restore(agreement, faceValue);
    await logAudit(null, 'script.agreement_restore_contract_terms', 'agreements', agreement.id, {
      total_amount_before: Number(agreement.total_amount),
      total_amount_after: faceValue,
      weekly_amount: weekly,
      total_weeks: weeks,
      paid_total: +paidTotal.toFixed(2),
      instalment_before: instalmentBefore,
      waived_weeks_preserved: waivedPreserved,
    });
    console.log(`    REPAIRED${waivedPreserved ? `     ${waivedPreserved} waived week(s) preserved` : ''}\n`);
    repaired++;
  }

  console.log(args.apply
    ? `Repaired ${repaired}, skipped ${refused}.`
    : `Would repair ${repaired}, would skip ${refused}. Re-run with --apply to write.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[restore-contract-terms] failed:', error);
      process.exit(1);
    });
}

// Exported so the repair can be exercised against a real schedule in tests
// rather than only run at a terminal against live money.
module.exports = { candidates, restore, refusalFor, paidTotalFor, DAMAGE_THRESHOLD, REPAIRABLE_STATUSES };
