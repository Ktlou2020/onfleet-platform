'use strict';

// Postgres equivalents of utils/helpers.js's payment-schedule logic, for
// routes that have been migrated off SQLite. utils/helpers.js itself is
// NOT edited in place — applications.js, admin.js, and agreements.js still
// call the SQLite versions and are not migrated yet; changing the shared
// module would silently split their agreement/schedule writes across both
// databases (agreement row in SQLite, payment_schedules rows in Postgres).
// Once every caller is migrated, these replace helpers.js's versions and
// this file goes away.
//
// Each function that participates in a larger transaction takes an optional
// trailing `db` parameter (a pgDb.query-shaped object — either the module's
// own `pgDb`, or a `client` checked out via pgDb.withTransaction) so the
// caller can make agreement-create-plus-schedule-plus-bike-update atomic.

const pgDb = require('../pgDb');
const { addDays, generateAgreementNo } = require('./helpers');

async function logAudit(actorId, action, entity, entityId, metadata = {}, ip = null) {
  try {
    await pgDb.query(
      `INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
      [actorId, action, entity, entityId, JSON.stringify(metadata), ip]
    );
  } catch (e) {
    console.error('[logAudit] failed:', e.message);
  }
}

// The schedule is a view of the contract, not a second opinion on it. Laying
// down totalWeeks flat instalments overshoots whenever weekly x weeks doesn't
// land exactly on total_amount, and that surplus becomes a final week the rider
// can never clear: it stays 'overdue' forever, and the daily overdue notice
// keeps firing. One rider finished paying his bike — R64,268.87 against a
// R64,190.20 contract — and was still sent "URGENT: pay immediately to avoid
// agreement default" every day for a month, because his schedule had been laid
// down as 81 x R800 = R64,800.
//
// Settle the difference on the final instalment so the schedule always sums to
// what is actually owed. total_amount is already the billing authority — the
// payment cap in routes/payments.js works off it, not off this table — so this
// makes the schedule agree with the figure that was always in charge.
async function buildPaymentSchedule(agreementId, weeklyAmount, totalWeeks, startDate, db = pgDb) {
  if (totalWeeks <= 0) return;

  const weekly = +Number(weeklyAmount).toFixed(2);
  let finalInstalment = weekly;
  const { rows: agreementRows } = await db.query('SELECT total_amount FROM agreements WHERE id = $1', [agreementId]);
  const contractTotal = Number(agreementRows[0]?.total_amount);
  if (Number.isFinite(contractTotal) && contractTotal > 0) {
    const remainder = +(contractTotal - weekly * (totalWeeks - 1)).toFixed(2);
    // Only a plausible last instalment is trusted. A remainder that is negative
    // or larger than two ordinary weeks means total_amount and the weekly terms
    // disagree about more than rounding — the term length is wrong — and
    // quietly reshaping the schedule would bury that rather than fix it.
    if (remainder > 0 && remainder <= weekly * 2) {
      finalInstalment = remainder;
    } else {
      console.warn(`[buildPaymentSchedule] agreement ${agreementId}: ${totalWeeks} x R${weekly.toFixed(2)} ` +
        `cannot be reconciled to a total of R${contractTotal.toFixed(2)} — leaving the schedule flat. ` +
        `Check total_weeks against the contract.`);
    }
  }

  const values = [];
  const placeholders = [];
  for (let i = 1; i <= totalWeeks; i++) {
    const base = values.length;
    placeholders.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4})`);
    values.push(agreementId, i, addDays(startDate, (i - 1) * 7), i === totalWeeks ? finalInstalment : weekly);
  }
  await db.query(
    `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due) VALUES ${placeholders.join(',')}`,
    values
  );
}

async function recalcScheduleStatuses(agreementId, db = pgDb) {
  const today = new Date().toISOString().slice(0, 10);
  await db.query(`
    UPDATE payment_schedules SET status = CASE
      WHEN amount_paid >= amount_due THEN 'paid'
      WHEN amount_paid > 0 AND due_date < $2 THEN 'overdue'
      WHEN amount_paid > 0 THEN 'partial'
      WHEN due_date < $2 THEN 'overdue'
      ELSE 'pending'
    END
    WHERE agreement_id = $1 AND status != 'waived'
  `, [agreementId, today]);
}

// Cascades every successful payment against open schedule rows, oldest week
// first — the same iterative allocation algorithm as helpers.js, ported
// mechanically (not batched into set-based SQL) since it's a stateful,
// order-dependent cascade, not an independent per-row transform.
async function rebuildScheduleAllocations(agreementId, db = pgDb) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: schedules } = await db.query(
    `SELECT * FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number ASC`, [agreementId]
  );
  if (!schedules.length) return;

  for (const s of schedules) {
    if (s.status === 'waived') {
      await db.query(`UPDATE payment_schedules SET amount_paid=0, paid_at=NULL, status='waived' WHERE id=$1`, [s.id]);
    } else {
      await db.query(
        `UPDATE payment_schedules SET amount_paid=0, paid_at=NULL, status=$2 WHERE id=$1`,
        [s.id, s.due_date < today ? 'overdue' : 'pending']
      );
    }
  }

  const { rows: payments } = await db.query(
    `SELECT * FROM payments WHERE agreement_id = $1 AND status = 'success' ORDER BY COALESCE(paid_at, created_at) ASC, id ASC`,
    [agreementId]
  );
  const { rows: applicable } = await db.query(
    `SELECT * FROM payment_schedules WHERE agreement_id = $1 AND status != 'waived' ORDER BY week_number ASC`,
    [agreementId]
  );

  for (const payment of payments) {
    // pg returns NUMERIC columns as strings ('0.00' is truthy in JS) — convert
    // each column to a number BEFORE falling through, or a genuine zero
    // net_amount would never fall back to amount.
    let remaining = Number(payment.net_amount) || Number(payment.amount) || 0;
    for (const s of applicable) {
      if (remaining <= 0) break;
      const owed = +(Number(s.amount_due) - Number(s.amount_paid || 0)).toFixed(2);
      if (owed <= 0) continue;
      const applied = Math.min(remaining, owed);
      s.amount_paid = +(Number(s.amount_paid || 0) + applied).toFixed(2);
      s.paid_at = s.paid_at || payment.paid_at || payment.created_at || null;
      s.status = s.amount_paid >= Number(s.amount_due) ? 'paid' : 'partial';
      await db.query(
        `UPDATE payment_schedules SET amount_paid=$1, paid_at=$2, status=$3 WHERE id=$4`,
        [s.amount_paid, s.paid_at, s.status, s.id]
      );
      remaining = +(remaining - applied).toFixed(2);
    }
  }

  for (const s of applicable) {
    let status = s.status;
    if (Number(s.amount_paid || 0) >= Number(s.amount_due || 0)) status = 'paid';
    else if (Number(s.amount_paid || 0) > 0 && s.due_date < today) status = 'overdue';
    else if (Number(s.amount_paid || 0) > 0) status = 'partial';
    else if (s.due_date < today) status = 'overdue';
    else status = 'pending';
    await db.query(
      `UPDATE payment_schedules SET amount_paid=$1, paid_at=$2, status=$3 WHERE id=$4`,
      [s.amount_paid || 0, s.paid_at || null, status, s.id]
    );
  }
}

async function updateAgreementBalance(agreementId, remainingBalance) {
  const targetRemaining = Number(remainingBalance);
  if (!Number.isFinite(targetRemaining) || targetRemaining < 0) throw new Error('Remaining balance must be zero or greater');

  const { rows: agreementRows } = await pgDb.query(
    'SELECT id, status, total_amount, weekly_amount, total_weeks FROM agreements WHERE id = $1', [agreementId]
  );
  const agreement = agreementRows[0];
  if (!agreement) throw new Error('Agreement not found');
  if (!['active', 'paused', 'defaulted'].includes(agreement.status)) {
    throw new Error('Only active, paused, or defaulted agreements can be updated');
  }

  // A slipped digit here is silent and expensive. This figure gets re-spread
  // across every open week, so R477,726.47 entered for R47,726.47 turned one
  // agreement's instalment into R8,426.82/week and left the rider showing ten
  // weeks overdue. The contract's own face value is the reference point: 1.5x
  // leaves room for arrears and fees, while an extra digit is always 10x.
  const contractValue = +(Number(agreement.weekly_amount || 0) * Number(agreement.total_weeks || 0)).toFixed(2);
  if (contractValue > 0 && targetRemaining > contractValue * 1.5) {
    throw new Error(
      `Remaining balance of R${targetRemaining.toFixed(2)} is more than 1.5x this agreement's ` +
      `contract value of R${contractValue.toFixed(2)} (${Number(agreement.total_weeks)} weeks x ` +
      `R${Number(agreement.weekly_amount).toFixed(2)}). Check for a mistyped digit. If the amount ` +
      `is genuinely correct, change the instalment count or weekly amount first.`
    );
  }

  const { rows: paidRows } = await pgDb.query(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount, 0), amount)), 0) AS total
     FROM payments WHERE agreement_id = $1 AND status = 'success'`, [agreementId]
  );
  const paidTotal = Number(paidRows[0].total || 0);

  const { rows: schedules } = await pgDb.query(
    `SELECT id, amount_due, amount_paid, status FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number ASC`,
    [agreementId]
  );
  if (!schedules.length) throw new Error('Payment schedule not found');

  const openSchedules = schedules.filter((s) => s.status !== 'waived' && Number(s.amount_due || 0) > Number(s.amount_paid || 0));
  if (!openSchedules.length && targetRemaining > 0) throw new Error('No unpaid schedule rows remain for this agreement');

  const currentOutstanding = openSchedules.reduce((sum, s) => sum + Math.max(Number(s.amount_due || 0) - Number(s.amount_paid || 0), 0), 0);
  const targetTotalAmount = +(paidTotal + targetRemaining).toFixed(2);

  await pgDb.withTransaction(async (client) => {
    if (openSchedules.length) {
      let remainingToAllocate = +targetRemaining.toFixed(2);
      for (let index = 0; index < openSchedules.length; index++) {
        const s = openSchedules[index];
        const currentOutstandingRow = Math.max(Number(s.amount_due || 0) - Number(s.amount_paid || 0), 0);
        const isLast = index === openSchedules.length - 1;
        const nextOutstanding = isLast
          ? remainingToAllocate
          : +(currentOutstanding > 0 ? (targetRemaining * currentOutstandingRow / currentOutstanding) : (targetRemaining / openSchedules.length)).toFixed(2);
        const nextAmountDue = +(Number(s.amount_paid || 0) + Math.max(nextOutstanding, 0)).toFixed(2);
        await client.query('UPDATE payment_schedules SET amount_due = $1 WHERE id = $2', [nextAmountDue, s.id]);
        remainingToAllocate = +(remainingToAllocate - Math.max(nextOutstanding, 0)).toFixed(2);
      }
    }
    await client.query('UPDATE agreements SET total_amount = $1 WHERE id = $2', [targetTotalAmount, agreementId]);
  });

  await rebuildScheduleAllocations(agreementId);

  return {
    agreement_id: agreementId,
    total_amount: targetTotalAmount,
    paid_total: +paidTotal.toFixed(2),
    remaining_balance: +targetRemaining.toFixed(2)
  };
}

module.exports = {
  logAudit, generateAgreementNo, addDays,
  buildPaymentSchedule, recalcScheduleStatuses, rebuildScheduleAllocations, updateAgreementBalance,
};
