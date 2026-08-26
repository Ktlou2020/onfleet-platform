'use strict';

// Tells the RIDER when their bike's engine is cut or restored.
//
// Before this, an engine cut — whether triggered manually by an admin or
// automatically on entering a no-go zone — notified only internal staff. The
// rider just found that the bike wouldn't start, with no explanation and (until
// the support contact was added) no in-app way to reach anyone. That silence is
// the worst moment in the product, so every path that changes the cut state
// routes through here.
//
// Deliberately fire-and-forget at the call sites: a notification failure must
// never stop the actual immobilisation from being recorded.

const pgDb = require('../pgDb');
const { sendNotification } = require('./notifierPg');

// The rider on the bike's active agreement. Returns null for unallocated stock
// (no agreement) — nobody to tell, which is a normal case, not an error.
async function riderForBike(bikeId) {
  const { rows } = await pgDb.query(
    `SELECT a.user_id, a.id AS agreement_id, b.registration, b.make, b.model
       FROM agreements a
       JOIN bikes b ON b.id = a.bike_id
      WHERE a.bike_id = $1 AND a.status = 'active'
      ORDER BY a.id DESC LIMIT 1`, [bikeId]);
  return rows[0] || null;
}

/**
 * @param {number} bikeId
 * @param {'cut'|'restored'} state
 * @param {object} [opts]
 * @param {string} [opts.reason]     Short human reason, e.g. a no-go zone name.
 * @param {boolean} [opts.automatic] True when a rule fired it rather than a person.
 */
async function notifyRiderEngineState(bikeId, state, { reason = null, automatic = false } = {}) {
  const rider = await riderForBike(bikeId);
  if (!rider) return null;

  const bikeLabel = rider.registration || `${rider.make || ''} ${rider.model || ''}`.trim() || `Bike #${bikeId}`;

  const cut = state === 'cut';
  const title = cut ? `Your bike has been immobilised — ${bikeLabel}` : `Your bike has been re-enabled — ${bikeLabel}`;

  const why = reason ? `Reason: ${reason}.`
    : automatic ? 'This was triggered automatically.'
    : 'This was done by the fleet team.';

  const message = cut
    ? `Your bike ${bikeLabel} has been immobilised and will not start.\n\n${why}\n\nPlease do not attempt to restart or tamper with the bike. Contact your fleet manager to resolve this — you can reach them from the Dashboard in your OnFleet app.`
    : `Good news — your bike ${bikeLabel} has been re-enabled and can be started again.\n\n${why}\n\nIf it still won't start, contact your fleet manager from the Dashboard in your OnFleet app.`;

  return sendNotification({
    userId: rider.user_id,
    channel: 'email',
    type: cut ? 'engine_cut' : 'engine_restored',
    title,
    message,
    entityType: 'bikes',
    entityId: bikeId,
    throwOnError: false,
  });
}

module.exports = { notifyRiderEngineState };
