'use strict';

const pgDb = require('../pgDb');
const { autoCut } = require('./autoEngineCut');

// The overnight curfew: bikes should be parked between 00:00 and 04:00 SAST,
// and one that is moving then is treated as stolen — its engine is cut without
// waiting for anybody to answer the alert.
//
// Three rules shape this, and each of them exists because of a way it could
// hurt somebody or take something that isn't ours:
//
//  1. The cut waits until the bike is down to walking pace. Killing a
//     motorcycle's engine at speed can put its rider on the road, and whoever
//     is behind them into the back of them. A thief gains nothing from the
//     delay — the bike dies at the first robot and will not restart.
//  2. Only bikes OnFleet still owns are cut. A bike that has been paid off or
//     sold belongs to the person riding it, and immobilising it is not ours to
//     do, whatever time it is.
//  3. Any bike can be exempted, and the whole curfew can be switched off
//     without a deploy — because the first time this strands a rider who was
//     legitimately working at 01:00, somebody needs to be able to stop it at
//     01:05.
//
// Arming is deliberately downstream of the night_movement alert rather than a
// rule of its own: that alert already waits for 90 seconds of sustained
// movement across 80+ metres, so a parked bike's GPS drift cannot reach this.

// Walking pace. Above this the bike is still being ridden and the cut waits.
const CUT_BELOW_KMH = 10;

// Statuses where the bike is still OnFleet's to immobilise. Named one by one
// rather than excluding the few that aren't, so that a status added later is
// left alone until somebody decides it belongs here — the cost of missing a
// theft is a bike, and the cost of guessing wrong the other way is cutting the
// engine of a bike its owner has paid for.
//
// 'sold', 'paid_off' and 'written_off' are the ones this deliberately omits:
// those bikes belong to a customer or an insurer. 'stolen' is included on
// purpose — a bike already known to be stolen is the last one to spare.
const CUTTABLE_STATUSES = ['active', 'ready_to_go', 'not_available', 'repairs', 'stationary', 'stolen'];

const SETTING_KEY = 'night_curfew_enabled';

// The window itself, matching the one tripService uses to raise night_movement.
// SAST is UTC+2 all year, so no DST arithmetic is needed.
const CURFEW_START_HOUR = 0;
const CURFEW_END_HOUR = 4;
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

function sastHour(at = new Date()) {
  return new Date(at.getTime() + SAST_OFFSET_MS).getUTCHours();
}

function inCurfew(at = new Date()) {
  const h = sastHour(at);
  return h >= CURFEW_START_HOUR && h < CURFEW_END_HOUR;
}

/** The moment the current curfew window ends, in UTC. */
function windowEnd(at = new Date()) {
  const sast = new Date(at.getTime() + SAST_OFFSET_MS);
  const end = new Date(Date.UTC(
    sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate(), CURFEW_END_HOUR, 0, 0));
  return new Date(end.getTime() - SAST_OFFSET_MS);
}

/**
 * A person has restored this bike's engine during the curfew, so the curfew
 * leaves it alone for the rest of tonight.
 *
 * Without this the operator is arguing with a loop: night_movement re-fires
 * after its cooldown, re-arms the cut, and the bike dies again the next time
 * it slows down. Restoring an engine at 01:00 is not an accident — it is
 * somebody deciding this particular bike is allowed to be moving — and the
 * system has to be able to hear that.
 *
 * Deliberately not permanent, and deliberately not a switch anybody has to
 * remember: it expires at 04:00 and the curfew covers the bike again tomorrow
 * night without a person touching it. Granted only inside the window, so
 * restoring an engine at two in the afternoon — after an arrears cut, say —
 * does not quietly stand the curfew down for a night nobody was thinking about.
 */
async function grantReprieve(bikeId, { at = new Date(), db = pgDb } = {}) {
  if (bikeId == null || !inCurfew(at)) return null;
  const until = windowEnd(at);
  await db.query('UPDATE bikes SET night_curfew_reprieve_until = $1 WHERE id = $2', [until, bikeId]);
  armed.delete(bikeId);
  console.log(`[night-curfew] bike ${bikeId} reprieved until ${until.toISOString()} — engine restored by hand during the window`);
  return until;
}

// Bikes whose night movement has been confirmed and whose cut is now waiting
// for them to slow down. In memory: a restart loses the pending cut, but the
// bike is still moving in the window, so night_movement fires again after its
// cooldown and re-arms it.
const armed = new Map(); // bikeId → { deviceId, armedAt, reason }

let enabledCache = null; // null = not yet read
async function isEnabled() {
  if (enabledCache !== null) return enabledCache;
  try {
    const { rows } = await pgDb.query('SELECT setting_value FROM app_settings WHERE setting_key = $1', [SETTING_KEY]);
    // Absent means on: the curfew is the point of asking for it.
    enabledCache = rows.length ? rows[0].setting_value !== 'false' : true;
  } catch {
    enabledCache = true;
  }
  return enabledCache;
}
function reloadSettings() { enabledCache = null; }

async function setEnabled(on) {
  await pgDb.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [SETTING_KEY, on ? 'true' : 'false']);
  enabledCache = !!on;
}

// Whether this particular bike is covered tonight. Checked once, when the
// alert confirms the movement — not on every ping.
async function covers(bikeId, { at = new Date() } = {}) {
  const { rows } = await pgDb.query(
    'SELECT status, night_curfew_exempt, night_curfew_reprieve_until FROM bikes WHERE id = $1', [bikeId]);
  const bike = rows[0];
  if (!bike) return false;
  if (bike.night_curfew_exempt) return false;
  // Somebody put this bike back on the road tonight, on purpose.
  if (bike.night_curfew_reprieve_until && new Date(bike.night_curfew_reprieve_until) > at) return false;
  return CUTTABLE_STATUSES.includes(bike.status);
}

// Called when night_movement has been confirmed for a bike.
async function arm(bikeId, deviceId, payload = {}, { at = new Date() } = {}) {
  if (deviceId == null) return false;
  if (armed.has(bikeId)) return false;
  if (!(await isEnabled())) return false;
  // `at` is passed through to covers so a reprieve is judged against the same
  // moment the movement happened, rather than whenever this happens to run.
  if (!(await covers(bikeId, { at }))) return false;
  armed.set(bikeId, { deviceId, armedAt: Date.now(), reason: 'Moving during the overnight curfew (00:00–04:00)', payload });
  console.log(`[night-curfew] armed bike ${bikeId} — cut will run once it is under ${CUT_BELOW_KMH} km/h`);
  return true;
}

// Called on every ping for an armed bike. Once armed the cut stands even if
// the bike outlasts the window: a bike confirmed as moving at 03:58 does not
// earn a pass by still moving at 04:02.
async function cutIfSlowEnough(bikeId, speedKmh) {
  const pending = armed.get(bikeId);
  if (!pending) return false;
  if (speedKmh > CUT_BELOW_KMH) return false;

  armed.delete(bikeId);
  return autoCut({
    deviceId: pending.deviceId,
    bikeId,
    reason: pending.reason,
    riderReason: 'it moved during the overnight curfew (00:00–04:00), when bikes should be parked',
    payload: { ...pending.payload, curfew: true, cut_at_speed_kmh: speedKmh, waited_ms: Date.now() - pending.armedAt },
  });
}

function isArmed(bikeId) { return armed.has(bikeId); }
function disarm(bikeId) { return armed.delete(bikeId); }
function clearAll() { armed.clear(); }

module.exports = {
  arm, cutIfSlowEnough, isArmed, disarm, clearAll,
  isEnabled, setEnabled, reloadSettings, covers,
  grantReprieve, inCurfew, windowEnd,
  CUT_BELOW_KMH, CUTTABLE_STATUSES, SETTING_KEY,
  CURFEW_START_HOUR, CURFEW_END_HOUR,
};
