'use strict';

const pgDb = require('../pgDb');
const { cutCommandForModel, restoreCommandForModel } = require('./engineCommands');
const nightCurfew = require('./nightCurfew');

// The overnight fleet lock.
//
// The curfew cuts a bike confirmed as moving between midnight and four. This
// is the other half: a bike parked when the window opens is immobilised, so
// it cannot be started at all. A thief does not get to ride off and stall at
// the first robot — the bike never starts.
//
// Three rules it never breaks:
//
//  1. Only a bike that is standing still is locked. A bike that is moving at
//     midnight is left entirely to the curfew, which waits for walking pace
//     or a switched-off ignition before it cuts. Nothing here ever sends an
//     immobilise to a motorcycle that might be under way.
//  2. The four o'clock sweep wakes only the bikes this put to sleep. A bike
//     cut for theft or arrears stays cut, because that was somebody's
//     decision and not a timer's.
//  3. Nobody is stranded without a way out. A rider can release their own
//     bike from the app, the control room can release anybody's, and a bike
//     that is still locked in daylight releases itself — because the one
//     failure that matters here is a morning sweep that did not run.
//
// Whose bikes are covered is the curfew's existing answer: cuttable status,
// not exempt, not reprieved. There is no second set of rules to keep in step.

const SETTING_KEY = 'night_lock_enabled';

// A bike reporting at or below this is standing still as far as this is
// concerned. Not zero: a parked bike's GPS drifts, and a lock refused because
// a stationary motorcycle reported 2 km/h is a bike left unlocked all night.
const STATIONARY_KMH = 3;

// How stale a position can be and still be believed. A tracker that has not
// spoken for hours might be anywhere, and the lock will reach it when it
// reconnects rather than being sent on the strength of last night's fix.
const FIX_MAX_AGE_MINUTES = 90;

let enabledCache = null;
async function isEnabled() {
  if (enabledCache !== null) return enabledCache;
  try {
    const { rows } = await pgDb.query('SELECT setting_value FROM app_settings WHERE setting_key = $1', [SETTING_KEY]);
    // Absent means off, unlike the curfew. The curfew responds to a bike that
    // is already being taken; this immobilises an entire fleet on a timer, and
    // a deployment should not start doing that because it was deployed.
    enabledCache = rows.length ? rows[0].setting_value === 'true' : false;
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}
function reloadSettings() { enabledCache = null; }

async function setEnabled(on) {
  await pgDb.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [SETTING_KEY, on ? 'true' : 'false']);
  enabledCache = !!on;
}

function send(imei, deviceId, command) {
  const teltonika = require('../tcp/teltonikaServer');
  return pgDb.query(
    `INSERT INTO tracking_commands (device_id, command, status, created_at) VALUES ($1,$2,'pending',NOW()) RETURNING id`,
    [deviceId, command])
    .then(({ rows }) => teltonika.sendCommand(imei, rows[0].id, command));
}

/**
 * Lock every covered bike that is standing still.
 *
 * Run at midnight. Bikes that are moving, offline, or reporting a stale fix
 * are skipped — the first because it would be unsafe, the other two because
 * we cannot see where they are. An offline bike is picked up by reassert()
 * the moment it reports in.
 */
async function lockAll({ at = new Date() } = {}) {
  if (!(await isEnabled())) return { locked: 0, skipped: 0, reason: 'disabled' };

  const { rows: candidates } = await pgDb.query(`
    SELECT d.id AS device_id, d.imei, d.model, d.engine_cut_active, d.night_lock_active,
           b.id AS bike_id, b.status, b.night_curfew_exempt, b.night_curfew_reprieve_until,
           b.night_lock_released_until,
           p.speed_kmh, p.ignition, p.recorded_at
      FROM tracking_devices d
      JOIN bikes b ON b.id = d.bike_id
      -- gps_pings is keyed on the motorcycle rather than the tracker, because
      -- a bike keeps its history when a device is swapped out.
      LEFT JOIN LATERAL (
        SELECT speed_kmh, ignition, recorded_at FROM gps_pings
         WHERE bike_id = b.id ORDER BY recorded_at DESC LIMIT 1
      ) p ON TRUE
     WHERE d.night_lock_active = FALSE`);

  let locked = 0;
  let skipped = 0;
  for (const row of candidates) {
    // A bike already cut is already immobilised, and taking it over would
    // mean the morning sweep restores something a person stopped on purpose.
    if (row.engine_cut_active) { skipped += 1; continue; }
    if (!(await covers(row, at))) { skipped += 1; continue; }
    if (!isStandingStill(row, at)) { skipped += 1; continue; }

    try {
      const sent = await send(row.imei, row.device_id, cutCommandForModel(row.model));
      await pgDb.query(
        'UPDATE tracking_devices SET night_lock_active = TRUE, night_locked_at = NOW() WHERE id = $1',
        [row.device_id]);
      locked += 1;
      if (!sent) console.log(`[night-lock] queued for ${row.imei} — will land when it reconnects`);
    } catch (e) {
      console.error(`[night-lock] could not lock ${row.imei}:`, e.message);
      skipped += 1;
    }
  }
  console.log(`[night-lock] locked ${locked}, left ${skipped} alone`);
  return { locked, skipped };
}

/**
 * Wake everything this put to sleep.
 *
 * Run at four. Deliberately indiscriminate about whether the window has
 * really ended or whether the bike is moving: releasing an immobiliser can
 * never hurt anybody, and the cost of being too careful here is a fleet that
 * cannot work in the morning.
 */
async function unlockAll() {
  const { rows } = await pgDb.query(
    'SELECT id, imei, model, bike_id FROM tracking_devices WHERE night_lock_active = TRUE');
  let unlocked = 0;
  for (const device of rows) {
    try {
      await releaseDevice(device);
      unlocked += 1;
    } catch (e) {
      console.error(`[night-lock] could not wake ${device.imei}:`, e.message);
    }
  }
  if (rows.length) console.log(`[night-lock] woke ${unlocked} of ${rows.length}`);
  return { unlocked, attempted: rows.length };
}

async function releaseDevice(device) {
  await send(device.imei, device.id, restoreCommandForModel(device.model));
  await pgDb.query(
    'UPDATE tracking_devices SET night_lock_active = FALSE, night_locked_at = NULL WHERE id = $1',
    [device.id]);
}

/**
 * One bike, let out for the rest of tonight.
 *
 * Used by the rider's own app and by the control room. The pass is recorded
 * on the bike so the next sweep — and reassert() — leave it alone until the
 * window closes, rather than locking it again a minute later.
 *
 * Only ever releases a night lock. A bike cut for theft or arrears is not
 * this function's to touch, and a rider pressing a button in an app is
 * certainly not the person to decide it.
 */
async function release(bikeId, { actorId = null, by = 'rider' } = {}) {
  const { rows } = await pgDb.query(
    `SELECT d.id, d.imei, d.model, d.night_lock_active, d.engine_cut_active, d.engine_cut_reason
       FROM tracking_devices d WHERE d.bike_id = $1`, [bikeId]);
  const device = rows[0];
  if (!device) return { ok: false, status: 404, error: 'No tracker on that bike' };

  if (device.engine_cut_active) {
    return {
      ok: false,
      status: 409,
      error: 'That bike was stopped for a reason, not by the overnight lock. Call the control room.',
      code: 'NOT_A_NIGHT_LOCK',
    };
  }
  if (!device.night_lock_active) {
    return { ok: false, status: 409, error: 'That bike is not locked', code: 'NOT_LOCKED' };
  }

  await releaseDevice(device);
  // Until the window closes, then it expires on its own and tomorrow night
  // covers the bike again without anybody remembering to switch it back.
  const until = nightCurfew.windowEnd();
  await pgDb.query('UPDATE bikes SET night_lock_released_until = $1 WHERE id = $2', [until, bikeId]);
  console.log(`[night-lock] bike ${bikeId} released by ${by}${actorId ? ` (user ${actorId})` : ''} until ${until.toISOString()}`);
  return { ok: true, released_until: until };
}

/**
 * Called on every position from a night-locked bike.
 *
 * Two jobs, and the second one matters more than the first.
 *
 * Inside the window: if the bike is reporting its ignition on, the lock did
 * not take or somebody has defeated it by cycling the power. Re-send — but
 * only while it is standing still, never to a motorcycle under way.
 *
 * Outside the window: it is daylight and this bike is still locked, which
 * means the four o'clock sweep did not run or did not reach it. Let it go.
 * A cron that fails should not be able to keep a fleet off the road, and the
 * bike reporting in is the most reliable signal available that it is stuck.
 */
async function onPosition({ deviceId, speedKmh, ignitionOn, at = new Date() }) {
  const { rows } = await pgDb.query(
    `SELECT d.id, d.imei, d.model, d.bike_id, d.night_lock_active
       FROM tracking_devices d WHERE d.id = $1 AND d.night_lock_active = TRUE`, [deviceId]);
  const device = rows[0];
  if (!device) return null;

  if (!nightCurfew.inCurfew(at)) {
    await releaseDevice(device);
    console.warn(`[night-lock] bike ${device.bike_id} was still locked after the window — released on its own report`);
    return 'self_released';
  }

  const movingOrUnknown = speedKmh == null || speedKmh > STATIONARY_KMH;
  if (ignitionOn === true && !movingOrUnknown) {
    await send(device.imei, device.id, cutCommandForModel(device.model));
    console.log(`[night-lock] re-asserted on ${device.imei} — it was started while locked`);
    return 'reasserted';
  }
  return null;
}

/** The curfew's rules, asked of a row the sweep already has in hand. */
async function covers(row, at) {
  if (!(await nightCurfew.isEnabled())) return false;
  if (row.night_curfew_exempt) return false;
  if (row.night_curfew_reprieve_until && new Date(row.night_curfew_reprieve_until) > at) return false;
  if (row.night_lock_released_until && new Date(row.night_lock_released_until) > at) return false;
  return nightCurfew.CUTTABLE_STATUSES.includes(row.status);
}

// gps_pings stores ignition as an integer, not a boolean: 1 is on, 0 is off,
// and null is a tracker with no ignition wire. Comparing it to `true` — which
// this did first — is false for every bike that has one, so a bike idling at
// a standstill with somebody sitting on it would have been locked.
function ignitionIsOn(value) {
  if (value === null || value === undefined) return false;
  return Number(value) === 1 || value === true;
}

function isStandingStill(row, at) {
  if (!row.recorded_at) return false;
  const ageMin = (at.getTime() - new Date(row.recorded_at).getTime()) / 60000;
  if (ageMin > FIX_MAX_AGE_MINUTES) return false;
  if (ignitionIsOn(row.ignition)) return false;
  const speed = row.speed_kmh == null ? null : Number(row.speed_kmh);
  return speed != null && speed <= STATIONARY_KMH;
}

module.exports = {
  lockAll, unlockAll, release, onPosition,
  isEnabled, setEnabled, reloadSettings,
  covers, isStandingStill, ignitionIsOn,
  SETTING_KEY, STATIONARY_KMH, FIX_MAX_AGE_MINUTES,
};
