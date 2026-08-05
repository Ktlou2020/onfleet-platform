'use strict';

// Postgres equivalent of services/agreementLifecycle.js, for routes migrated
// off SQLite (currently only fleet.js). Not edited in place — bikes.js is
// not migrated yet and still needs the SQLite version.

const pgDb = require('../pgDb');
const { logAudit } = require('../utils/helpersPg');

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function timestampIso() {
  return new Date().toISOString();
}

async function getAgreementForDiscontinuation(agreementId) {
  const { rows } = await pgDb.query(`
    SELECT a.*, b.status AS bike_status
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    WHERE a.id = $1
  `, [agreementId]);
  return rows[0];
}

async function waiveFutureScheduleRows(agreementId, fromDate = todayIso()) {
  const { rowCount } = await pgDb.query(`
    UPDATE payment_schedules
    SET status = 'waived'
    WHERE agreement_id = $1
      AND amount_paid < amount_due
      AND due_date >= $2
      AND status NOT IN ('paid', 'waived')
  `, [agreementId, fromDate]);
  return rowCount || 0;
}

async function discontinueAgreement({ agreementId, reason = 'manual_admin_discontinue', actorId = null, ip = null, auditAction = 'agreement.discontinued' }) {
  const agreement = await getAgreementForDiscontinuation(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (['completed', 'cancelled', 'discontinued'].includes(agreement.status)) {
    throw new Error(`Agreement cannot be discontinued from status ${agreement.status}`);
  }

  const at = timestampIso();
  await pgDb.query(`
    UPDATE agreements
    SET status = 'discontinued',
        discontinued_reason = $1,
        discontinued_at = $2,
        reinstated_at = NULL
    WHERE id = $3
  `, [reason, at, agreementId]);

  const waived = await waiveFutureScheduleRows(agreementId);

  await logAudit(actorId, auditAction, 'agreements', agreementId, {
    bike_id: Number(agreement.bike_id),
    previous_status: agreement.status,
    reason,
    waived_rows: waived
  }, ip);

  return { agreement, waived_rows: waived, discontinued_at: at };
}

async function findAgreementToDiscontinueForBike(bikeId) {
  const { rows } = await pgDb.query(`
    SELECT *
    FROM agreements
    WHERE bike_id = $1
      AND status IN ('active', 'paused')
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `, [bikeId]);
  return rows[0];
}

async function discontinueAgreementForStolenBike({ bikeId, actorId = null, ip = null }) {
  const agreement = await findAgreementToDiscontinueForBike(bikeId);
  if (!agreement) return { agreement: null, waived_rows: 0 };
  return discontinueAgreement({
    agreementId: agreement.id,
    reason: 'bike_stolen',
    actorId,
    ip,
    auditAction: 'agreement.auto_discontinued'
  });
}

async function reinstateDiscontinuedAgreement({ agreementId, actorId = null, ip = null }) {
  const agreement = await getAgreementForDiscontinuation(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  const allowedReasons = ['bike_stolen', 'admin_status_change'];
  if (agreement.status !== 'discontinued' || !allowedReasons.includes(agreement.discontinued_reason)) {
    throw new Error('Only discontinued agreements can be reinstated');
  }
  if (agreement.bike_status === 'stolen') {
    throw new Error('Recover the bike from stolen status before reinstating the agreement');
  }

  const today = todayIso();
  const at = timestampIso();
  await pgDb.query(`
    UPDATE agreements
    SET status = 'active',
        reinstated_at = $1,
        discontinued_reason = NULL
    WHERE id = $2
  `, [at, agreementId]);

  const { rowCount: restored } = await pgDb.query(`
    UPDATE payment_schedules
    SET status = CASE
      WHEN amount_paid >= amount_due THEN 'paid'
      WHEN amount_paid > 0 THEN 'partial'
      ELSE 'pending'
    END
    WHERE agreement_id = $1
      AND status = 'waived'
      AND due_date >= $2
  `, [agreementId, today]);

  await pgDb.query(`UPDATE bikes SET status = 'active' WHERE id = $1 AND status <> 'active'`, [agreement.bike_id]);

  await logAudit(actorId, 'agreement.reinstated', 'agreements', agreementId, {
    bike_id: Number(agreement.bike_id),
    restored_rows: restored || 0
  }, ip);

  return { agreement_id: Number(agreementId), restored_rows: restored || 0, bike_id: Number(agreement.bike_id) };
}

module.exports = {
  discontinueAgreement,
  discontinueAgreementForStolenBike,
  reinstateDiscontinuedAgreement
};
