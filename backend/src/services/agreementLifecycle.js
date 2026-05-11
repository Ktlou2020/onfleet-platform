const db = require('../db');
const { logAudit } = require('../utils/helpers');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function timestampIso() {
  return new Date().toISOString();
}

function discontinueAgreementForStolenBike({ bikeId, actorId = null, ip = null }) {
  const agreement = db.prepare(`SELECT * FROM agreements WHERE bike_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(bikeId);
  if (!agreement) return { agreement: null, waived_rows: 0 };

  const today = todayIso();
  const at = timestampIso();
  db.prepare(`UPDATE agreements
    SET status = 'discontinued',
        discontinued_reason = 'bike_stolen',
        discontinued_at = ?,
        reinstated_at = NULL
    WHERE id = ?`).run(at, agreement.id);

  const waived = db.prepare(`UPDATE payment_schedules
    SET status = 'waived'
    WHERE agreement_id = ?
      AND amount_paid < amount_due
      AND due_date >= ?
      AND status NOT IN ('paid', 'waived')`).run(agreement.id, today).changes || 0;

  logAudit(actorId, 'agreement.auto_discontinued', 'agreements', agreement.id, {
    bike_id: Number(bikeId),
    reason: 'bike_stolen',
    waived_rows: waived
  }, ip);

  return { agreement, waived_rows: waived };
}

function reinstateDiscontinuedAgreement({ agreementId, actorId = null, ip = null }) {
  const agreement = db.prepare(`SELECT a.*, b.status AS bike_status FROM agreements a JOIN bikes b ON b.id = a.bike_id WHERE a.id = ?`).get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status !== 'discontinued' || agreement.discontinued_reason !== 'bike_stolen') {
    throw new Error('Only theft-discontinued agreements can be reinstated');
  }
  if (agreement.bike_status === 'stolen') {
    throw new Error('Recover the bike from stolen status before reinstating the agreement');
  }

  const today = todayIso();
  const at = timestampIso();
  db.prepare(`UPDATE agreements
    SET status = 'active',
        reinstated_at = ?,
        discontinued_reason = NULL
    WHERE id = ?`).run(at, agreementId);

  const restored = db.prepare(`UPDATE payment_schedules
    SET status = CASE
      WHEN amount_paid >= amount_due THEN 'paid'
      WHEN amount_paid > 0 THEN 'partial'
      ELSE 'pending'
    END
    WHERE agreement_id = ?
      AND status = 'waived'
      AND due_date >= ?`).run(agreementId, today).changes || 0;

  db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ? AND status <> 'active'`).run(agreement.bike_id);

  logAudit(actorId, 'agreement.reinstated', 'agreements', agreementId, {
    bike_id: Number(agreement.bike_id),
    restored_rows: restored
  }, ip);

  return { agreement_id: Number(agreementId), restored_rows: restored, bike_id: Number(agreement.bike_id) };
}

module.exports = {
  discontinueAgreementForStolenBike,
  reinstateDiscontinuedAgreement
};
