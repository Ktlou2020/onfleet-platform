'use strict';

const pgDb = require('../pgDb');

// Whether a tracker's ignition reading can be believed.
//
// The towing alert means "the bike covered real road distance with the
// ignition off", which can only be a bike on the back of something. That
// reasoning collapses if the ignition line was never wired: the tracker
// reports element 239 as 0 for ever, every ordinary ride looks like a tow, and
// the same dead 0 makes every ride look like unauthorised movement too.
//
// A present-but-dead ignition line is indistinguishable from a genuinely
// switched-off bike in any single ping. Over a tracker's life it is obvious:
// a wired ignition reads 1 the first time somebody turns the key. So a
// tracker earns trust by having reported ignition ON at least once, and until
// it does, its ignition reading is treated as absent rather than as "off" —
// trips fall back to movement, and neither towing nor unauthorised movement
// is raised from it.
//
// The failure mode this picks is deliberate: a tracker we are unsure about
// goes quiet rather than crying wolf. A tracker that cries wolf every
// afternoon is why nobody reads the alerts by the time a bike is actually
// taken.

const trusted = new Set(); // deviceIds whose ignition has been seen ON
let primed = false;

function isTrusted(deviceId) {
  return deviceId != null && trusted.has(Number(deviceId));
}

// Called on every ping. Cheap on the hot path: a Set hit, and a write only on
// the single ping that first proves the wire works.
function note(deviceId, ignitionRaw) {
  if (deviceId == null) return false;
  const id = Number(deviceId);
  if (trusted.has(id)) return false;
  if (!ignitionRaw) return false;
  trusted.add(id);
  pgDb.query(
    'UPDATE tracking_devices SET ignition_trusted_at = NOW() WHERE id = $1 AND ignition_trusted_at IS NULL', [id]
  ).catch((e) => console.error('[ignition-trust] could not record:', e.message));
  console.log(`[ignition-trust] device ${id} reported ignition on — its ignition line is wired`);
  return true;
}

async function prime() {
  const { rows } = await pgDb.query('SELECT id FROM tracking_devices WHERE ignition_trusted_at IS NOT NULL');
  for (const r of rows) trusted.add(Number(r.id));
  primed = true;
  return trusted.size;
}

// One-off, from history, so a fleet that has been running for months does not
// spend a ride per tracker with towing detection suppressed.
//
// Deliberately not done in a migration: it reads the whole ping table, and a
// migration that runs long or fails stops the service from starting at all.
// Here it is a background job that can be slow or fail harmlessly.
async function backfillFromPings(days = 30) {
  const { rows } = await pgDb.query(
    `SELECT d.id
       FROM tracking_devices d
      WHERE d.bike_id IS NOT NULL
        AND d.ignition_trusted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM gps_pings p
           WHERE p.bike_id = d.bike_id
             AND p.ignition = 1
             AND p.recorded_at > NOW() - ($1 || ' days')::interval
        )`, [String(days)]);
  for (const r of rows) {
    trusted.add(Number(r.id));
    await pgDb.query(
      'UPDATE tracking_devices SET ignition_trusted_at = NOW() WHERE id = $1 AND ignition_trusted_at IS NULL', [r.id]);
  }
  if (rows.length) console.log(`[ignition-trust] ${rows.length} tracker(s) trusted from history`);
  return rows.length;
}

// Trackers wired to a bike that have never once reported the ignition on.
// These are the ones whose towing and movement alerts were noise.
async function untrustedDevices() {
  const { rows } = await pgDb.query(
    `SELECT d.id, d.imei, d.label, b.registration
       FROM tracking_devices d
       LEFT JOIN bikes b ON b.id = d.bike_id
      WHERE d.bike_id IS NOT NULL AND d.ignition_trusted_at IS NULL
      ORDER BY b.registration NULLS LAST`);
  return rows;
}

function reset() { trusted.clear(); primed = false; }
function isPrimed() { return primed; }

// Warm at boot, then fill in from history behind it.
setTimeout(() => {
  prime()
    .then(() => backfillFromPings())
    .catch((e) => console.error('[ignition-trust] warm-up failed:', e.message));
}, 3000);

module.exports = { isTrusted, note, prime, backfillFromPings, untrustedDevices, reset, isPrimed };
