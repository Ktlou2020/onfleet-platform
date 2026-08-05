'use strict';

// Postgres equivalent of utils/bikeStatus.js's DB-touching functions, for
// routes migrated off SQLite (currently only fleet.js). The original is used
// by bikes.js, agreements.js, applications.js, and ops scripts that are not
// migrated yet — not edited in place for the same reason as helpersPg.js.
// Pure functions (normalizeBikeStatus, getBikeStatusLabel, etc.) are reused
// directly from the original since they touch no database.

const pgDb = require('../pgDb');
const { normalizeBikeStatus } = require('./bikeStatus');

async function bikeHasActiveAgreement(bikeId) {
  if (!bikeId) return false;
  const { rows } = await pgDb.query(`SELECT 1 FROM agreements WHERE bike_id = $1 AND status = 'active' LIMIT 1`, [bikeId]);
  return rows.length > 0;
}

async function pauseActiveBikeAgreements(bikeId) {
  const { rowCount } = await pgDb.query(`UPDATE agreements SET status = 'paused' WHERE bike_id = $1 AND status = 'active'`, [bikeId]);
  return rowCount || 0;
}

async function setBikeStatus(bikeId, requestedStatus) {
  const { rows } = await pgDb.query(`SELECT id, status FROM bikes WHERE id = $1`, [bikeId]);
  const bike = rows[0];
  if (!bike) throw new Error('Bike not found');

  const hasActiveAgreement = await bikeHasActiveAgreement(bikeId);
  const nextStatus = normalizeBikeStatus(requestedStatus, { bikeId, hasAllocation: hasActiveAgreement });
  if (nextStatus === 'active' && !hasActiveAgreement) {
    throw new Error('Active status requires a current active agreement');
  }

  let pausedAgreements = 0;
  if (nextStatus === 'repairs') {
    pausedAgreements = await pauseActiveBikeAgreements(bikeId);
  }

  await pgDb.query(`UPDATE bikes SET status = $1 WHERE id = $2`, [nextStatus, bikeId]);

  return {
    previous_status: bike.status,
    next_status: nextStatus,
    paused_agreements: pausedAgreements,
    had_active_agreement: hasActiveAgreement
  };
}

module.exports = { bikeHasActiveAgreement, pauseActiveBikeAgreements, setBikeStatus };
