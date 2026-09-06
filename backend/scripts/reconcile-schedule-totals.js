'use strict';

// Trims schedules that bill more than the contract they belong to.
//
// buildPaymentSchedule used to lay down total_weeks flat instalments without
// checking the total, so any agreement where weekly x weeks missed
// total_amount carried a surplus final week the rider could never clear. It
// stayed 'overdue' forever and kept the daily overdue notice firing — one
// rider finished paying his bike and was still chased daily for a month. The
// generator is fixed; this repairs the agreements laid down before that.
//
// Only ever reduces what a rider appears to owe, and only down to
// total_amount, which is already the billing authority (routes/payments.js
// caps payment against it, not against payment_schedules). Skips anything
// re-priced by an admin balance edit — those carry a human decision this
// should not overwrite.
//
//   node scripts/reconcile-schedule-totals.js              # dry run, prints every change
//   APPLY=yes node scripts/reconcile-schedule-totals.js    # apply, in a guarded transaction each

const pgDb = require('../src/pgDb');
const { rebuildScheduleAllocations, recalcScheduleStatuses, logAudit } = require('../src/utils/helpersPg');
const APPLY = process.env.APPLY === 'yes';

(async () => {
  const { rows: targets } = await pgDb.query(`
    WITH s AS (SELECT agreement_id, SUM(amount_due) AS sched_total, COUNT(DISTINCT amount_due) AS bands
                 FROM payment_schedules GROUP BY agreement_id)
    SELECT a.id, a.agreement_no, a.total_amount, s.sched_total, s.bands,
           ROUND(s.sched_total - a.total_amount, 2) AS excess
      FROM agreements a JOIN s ON s.agreement_id = a.id
     WHERE a.status = 'active' AND ROUND(s.sched_total,2) > ROUND(a.total_amount,2)
     ORDER BY a.id`);

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} active agreements\n`);
  let changed = 0, skipped = 0;

  for (const t of targets) {
    const excess = Number(t.excess);
    const { rows: lastRows } = await pgDb.query(
      `SELECT id, week_number, amount_due, amount_paid, status FROM payment_schedules
        WHERE agreement_id = $1 ORDER BY week_number DESC LIMIT 1`, [t.id]);
    const last = lastRows[0];
    const newDue = +(Number(last.amount_due) - excess).toFixed(2);

    if (Number(t.bands) > 1) { console.log(`  SKIP ${t.agreement_no}: re-priced (${t.bands} bands) — leave to a human`); skipped++; continue; }
    if (newDue <= 0)         { console.log(`  SKIP ${t.agreement_no}: excess R${excess} >= final week R${last.amount_due}`); skipped++; continue; }

    console.log(`  ${t.agreement_no}: week ${last.week_number} R${Number(last.amount_due).toFixed(2)} -> R${newDue.toFixed(2)} ` +
                `(schedule R${Number(t.sched_total).toFixed(2)} -> R${Number(t.total_amount).toFixed(2)}, excess R${excess.toFixed(2)})`);

    if (APPLY) {
      await pgDb.withTransaction(async (client) => {
        const upd = await client.query(
          `UPDATE payment_schedules SET amount_due = $1 WHERE id = $2 AND amount_due = $3`,
          [newDue, last.id, last.amount_due]);
        if (upd.rowCount !== 1) throw new Error(`guard failed on ${t.agreement_no} — row changed underneath`);
      });
      await rebuildScheduleAllocations(t.id);
      await recalcScheduleStatuses(t.id);
      await logAudit(null, 'admin.agreement_schedule_reconciled', 'agreements', t.id, {
        reason: 'schedule total exceeded contract total; trimmed final instalment',
        excess_removed: excess, final_week: last.week_number,
        was: Number(last.amount_due), now: newDue, contract_total: Number(t.total_amount),
      });
    }
    changed++;
  }

  console.log(`\n${APPLY ? 'applied' : 'would change'}: ${changed}   skipped: ${skipped}`);
  if (APPLY) {
    const { rows: check } = await pgDb.query(`
      WITH s AS (SELECT agreement_id, SUM(amount_due) AS st FROM payment_schedules GROUP BY agreement_id)
      SELECT COUNT(*) AS still_overstated FROM agreements a JOIN s ON s.agreement_id=a.id
       WHERE a.status='active' AND ROUND(s.st,2) > ROUND(a.total_amount,2)`);
    console.log(`active agreements still overstated: ${check[0].still_overstated}`);
  }
  await pgDb.pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
