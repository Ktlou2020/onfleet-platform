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
  const rows = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ?`).all(agreementId);
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

module.exports = { logAudit, generateAgreementNo, addDays, buildPaymentSchedule, recalcScheduleStatuses };
