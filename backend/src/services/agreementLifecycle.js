const db = require('../db');
const { logAudit } = require('../utils/helpers');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function timestampIso() {
  return new Date().toISOString();
}

function getAgreementForDiscontinuation(agreementId) {
  return db.prepare(`
    SELECT a.*, b.status AS bike_status
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    WHERE a.id = ?
  `).get(agreementId);
}

function waiveFutureScheduleRows(agreementId, fromDate = todayIso()) {
  return db.prepare(`
    UPDATE payment_schedules
    SET status = 'waived'
    WHERE agreement_id = ?
      AND amount_paid < amount_due
      AND due_date >= ?
      AND status NOT IN ('paid', 'waived')
  `).run(agreementId, fromDate).changes || 0;
}

function discontinueAgreement({ agreementId, reason = 'manual_admin_discontinue', actorId = null, ip = null, auditAction = 'agreement.discontinued' }) {
  const agreement = getAgreementForDiscontinuation(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (['completed', 'cancelled', 'discontinued'].includes(agreement.status)) {
    throw new Error(`Agreement cannot be discontinued from status ${agreement.status}`);
  }

  const at = timestampIso();
  db.prepare(`
    UPDATE agreements
    SET status = 'discontinued',
        discontinued_reason = ?,
        discontinued_at = ?,
        reinstated_at = NULL
    WHERE id = ?
  `).run(reason, at, agreementId);

  const waived = waiveFutureScheduleRows(agreementId);

  logAudit(actorId, auditAction, 'agreements', agreementId, {
    bike_id: Number(agreement.bike_id),
    previous_status: agreement.status,
    reason,
    waived_rows: waived
  }, ip);

  return { agreement, waived_rows: waived, discontinued_at: at };
}

function findAgreementToDiscontinueForBike(bikeId) {
  return db.prepare(`
    SELECT *
    FROM agreements
    WHERE bike_id = ?
      AND status IN ('active', 'paused')
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `).get(bikeId);
}

function discontinueAgreementForStolenBike({ bikeId, actorId = null, ip = null }) {
  const agreement = findAgreementToDiscontinueForBike(bikeId);
  if (!agreement) return { agreement: null, waived_rows: 0 };
  return discontinueAgreement({
    agreementId: agreement.id,
    reason: 'bike_stolen',
    actorId,
    ip,
    auditAction: 'agreement.auto_discontinued'
  });
}

function reinstateDiscontinuedAgreement({ agreementId, actorId = null, ip = null }) {
  const agreement = getAgreementForDiscontinuation(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status !== 'discontinued' || agreement.discontinued_reason !== 'bike_stolen') {
    throw new Error('Only theft-discontinued agreements can be reinstated');
  }
  if (agreement.bike_status === 'stolen') {
    throw new Error('Recover the bike from stolen status before reinstating the agreement');
  }

  const today = todayIso();
  const at = timestampIso();
  db.prepare(`
    UPDATE agreements
    SET status = 'active',
        reinstated_at = ?,
        discontinued_reason = NULL
    WHERE id = ?
  `).run(at, agreementId);

  const restored = db.prepare(`
    UPDATE payment_schedules
    SET status = CASE
      WHEN amount_paid >= amount_due THEN 'paid'
      WHEN amount_paid > 0 THEN 'partial'
      ELSE 'pending'
    END
    WHERE agreement_id = ?
      AND status = 'waived'
      AND due_date >= ?
  `).run(agreementId, today).changes || 0;

  db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ? AND status <> 'active'`).run(agreement.bike_id);

  logAudit(actorId, 'agreement.reinstated', 'agreements', agreementId, {
    bike_id: Number(agreement.bike_id),
    restored_rows: restored
  }, ip);

  return { agreement_id: Number(agreementId), restored_rows: restored, bike_id: Number(agreement.bike_id) };
}

module.exports = {
  discontinueAgreement,
  discontinueAgreementForStolenBike,
  reinstateDiscontinuedAgreement
};
