const db = require('../db');

function logAudit(actorId, action, entity, entityId, metadata = {}, ip = null) {
  db.prepare(`INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata, ip)
              VALUES (?,?,?,?,?,?)`).run(actorId, action, entity, entityId, JSON.stringify(metadata), ip);
}

function generateAgreementNo() {
  const year = new Date().getFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `OF-${year}-${rand}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildPaymentSchedule(agreementId, weeklyAmount, totalWeeks, startDate) {
  const insert = db.prepare(`INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due)
                             VALUES (?,?,?,?)`);
  const tx = db.transaction(() => {
    for (let i = 1; i <= totalWeeks; i++) {
      insert.run(agreementId, i, addDays(startDate, (i - 1) * 7), weeklyAmount);
    }
  });
  tx();
}

function recalcScheduleStatuses(agreementId) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? AND status != 'waived'`).all(agreementId);
  const upd = db.prepare(`UPDATE payment_schedules SET status = ? WHERE id = ?`);
  for (const r of rows) {
    let status = r.status;
    if (r.amount_paid >= r.amount_due) status = 'paid';
    else if (r.amount_paid > 0 && r.due_date < today) status = 'overdue';
    else if (r.amount_paid > 0) status = 'partial';
    else if (r.due_date < today) status = 'overdue';
    else status = 'pending';
    upd.run(status, r.id);
  }
}

function rebuildScheduleAllocations(agreementId) {
  const today = new Date().toISOString().slice(0, 10);
  const schedules = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number ASC`).all(agreementId);
  if (!schedules.length) return;

  const reset = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);
  for (const s of schedules) {
    if (s.status === 'waived') {
      reset.run(0, null, 'waived', s.id);
    } else {
      reset.run(0, null, s.due_date < today ? 'overdue' : 'pending', s.id);
    }
  }

  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? AND status = 'success' ORDER BY COALESCE(paid_at, created_at) ASC, id ASC`).all(agreementId);
  const applicable = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  const updateApplied = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);

  for (const payment of payments) {
    let remaining = Number(payment.net_amount || payment.amount || 0);
    for (const s of applicable) {
      if (remaining <= 0) break;
      const owed = +(Number(s.amount_due) - Number(s.amount_paid || 0)).toFixed(2);
      if (owed <= 0) continue;
      const applied = Math.min(remaining, owed);
      s.amount_paid = +(Number(s.amount_paid || 0) + applied).toFixed(2);
      s.paid_at = s.paid_at || payment.paid_at || payment.created_at || null;
      s.status = s.amount_paid >= Number(s.amount_due) ? 'paid' : 'partial';
      updateApplied.run(s.amount_paid, s.paid_at, s.status, s.id);
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
    updateApplied.run(s.amount_paid || 0, s.paid_at || null, status, s.id);
  }
}

function updateAgreementBalance(agreementId, remainingBalance) {
  const targetRemaining = Number(remainingBalance);
  if (!Number.isFinite(targetRemaining) || targetRemaining < 0) throw new Error('Remaining balance must be zero or greater');

  const agreement = db.prepare('SELECT id, status, total_amount FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (!['active', 'paused', 'defaulted'].includes(agreement.status)) {
    throw new Error('Only active, paused, or defaulted agreements can be updated');
  }

  const paidTotal = Number(db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount, 0), amount)), 0) AS total
    FROM payments WHERE agreement_id = ? AND status = 'success'`).get(agreementId).total || 0);
  const schedules = db.prepare(`SELECT id, amount_due, amount_paid, status
    FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number ASC`).all(agreementId);
  if (!schedules.length) throw new Error('Payment schedule not found');

  const openSchedules = schedules.filter((s) => s.status !== 'waived' && Number(s.amount_due || 0) > Number(s.amount_paid || 0));
  if (!openSchedules.length && targetRemaining > 0) throw new Error('No unpaid schedule rows remain for this agreement');

  const currentOutstanding = openSchedules.reduce((sum, s) => sum + Math.max(Number(s.amount_due || 0) - Number(s.amount_paid || 0), 0), 0);
  const targetTotalAmount = +(paidTotal + targetRemaining).toFixed(2);

  db.transaction(() => {
    if (openSchedules.length) {
      let remainingToAllocate = +targetRemaining.toFixed(2);
      openSchedules.forEach((s, index) => {
        const currentOutstandingRow = Math.max(Number(s.amount_due || 0) - Number(s.amount_paid || 0), 0);
        const isLast = index === openSchedules.length - 1;
        const nextOutstanding = isLast
          ? remainingToAllocate
          : +(currentOutstanding > 0 ? (targetRemaining * currentOutstandingRow / currentOutstanding) : (targetRemaining / openSchedules.length)).toFixed(2);
        const nextAmountDue = +(Number(s.amount_paid || 0) + Math.max(nextOutstanding, 0)).toFixed(2);
        db.prepare('UPDATE payment_schedules SET amount_due = ? WHERE id = ?').run(nextAmountDue, s.id);
        remainingToAllocate = +(remainingToAllocate - Math.max(nextOutstanding, 0)).toFixed(2);
      });
    }
    db.prepare('UPDATE agreements SET total_amount = ? WHERE id = ?').run(targetTotalAmount, agreementId);
  })();

  rebuildScheduleAllocations(agreementId);

  return {
    agreement_id: agreementId,
    total_amount: targetTotalAmount,
    paid_total: +paidTotal.toFixed(2),
    remaining_balance: +targetRemaining.toFixed(2)
  };
}

module.exports = { logAudit, generateAgreementNo, addDays, buildPaymentSchedule, recalcScheduleStatuses, rebuildScheduleAllocations, updateAgreementBalance };
