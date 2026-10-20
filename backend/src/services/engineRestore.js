'use strict';

const pgDb = require('../pgDb');

// Letting a bike run again, in one place.
//
// Restoring an engine is three things that have to happen together, and the
// operator console learned each of them the hard way:
//
//   The cut is cleared. Obvious.
//   The night lock flag goes with it, or the next midnight sweep puts the
//     bike straight back to sleep — somebody has just decided it may run.
//   A curfew reprieve is granted, or the next night_movement alert re-arms
//     the cut and the bike dies again. That happened to MJ71MRGP: correct
//     behaviour, in a loop the operator could not break.
//
// Written out longhand in the console's restore handler, it was correct.
// Written out a second time in the MoMo settlement path, it would have been
// correct until one of the three changed. So it lives here and both call it.

/**
 * Let this device's bike run again.
 *
 * Returns what actually changed, so a caller can tell a rider "your bike is
 * unlocked" only when it really is, and say nothing when the engine was never
 * cut in the first place.
 */
async function restoreEngine(deviceId, { actorId = null, db = pgDb } = {}) {
  const { rows } = await db.query(
    `UPDATE tracking_devices
        SET engine_cut_active = FALSE, engine_cut_reason = NULL,
            engine_cut_at = NULL, engine_cut_by = NULL,
            night_lock_active = FALSE, night_locked_at = NULL
      WHERE id = $1 AND engine_cut_active = TRUE
      RETURNING id, bike_id, imei, model, engine_cut_reason`,
    [deviceId]);

  const device = rows[0];
  if (!device) return { restored: false };

  // Required here rather than at module scope: nightCurfew pulls in
  // autoEngineCut, which pulls back this way.
  const nightCurfew = require('./nightCurfew');
  let reprievedUntil = null;
  try {
    reprievedUntil = await nightCurfew.grantReprieve(device.bike_id);
  } catch (e) {
    // A reprieve that could not be written is worth knowing about and is not
    // worth refusing to unlock a bike over. Outside the window it is a no-op
    // anyway.
    console.error('[engine-restore] could not grant a curfew reprieve:', e.message);
  }

  return { restored: true, bikeId: device.bike_id, imei: device.imei, reprievedUntil, actorId };
}

/** The device on a bike, if it has one. */
async function deviceForBike(bikeId, db = pgDb) {
  const { rows } = await db.query(
    'SELECT id, imei, engine_cut_active, engine_cut_reason FROM tracking_devices WHERE bike_id = $1', [bikeId]);
  return rows[0] || null;
}

module.exports = { restoreEngine, deviceForBike };
