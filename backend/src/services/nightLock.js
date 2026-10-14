'use strict';

const pgDb = require('../pgDb');
const { cutCommandForModel, restoreCommandForModel } = require('./engineCommands');
const { MAX_ACTIONABLE_FIX_AGE_MS } = require('../constants/gps');
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

// How long before the same device may be sent the cut again.
//
// The re-assert fires on every position from a locked bike whose ignition is
// on, and a tracker being started over and over reports every few seconds. On
// the night of 13 October one bike took 113 of the 175 cut commands sent to
// the whole fleet — about one a minute for an hour and a half, while somebody
// tried to ride it away. Every one was correct and every one after the first
// was redundant: the output is already latched, and the next attempt meets the
// same cut whether it was sent once or a hundred times.
//
// So the first goes straight out and the rest wait. A shorter interval costs
// SIM data and a command queue nobody can read; a longer one costs a few
// seconds before a cut that is already in force is restated.
const REASSERT_INTERVAL_MS = 60 * 1000;

// device id → when it was last re-asserted. In memory and per process, so a
// restart costs one extra command rather than a missed one, which is the right
// way round for this.
const lastReassert = new Map();

// Forgotten at the morning sweep, and by tests between cases — the table is
// truncated with RESTART IDENTITY, so device ids repeat and one test's
// throttle would otherwise silence the next one's re-assert.
function clearReassertMemory() { lastReassert.clear(); }

// How stale a position can be and still be believed. A tracker that has not
// spoken for hours might be anywhere, and the lock will reach it when it
// reconnects rather than being sent on the strength of last night's fix.
const FIX_MAX_AGE_MINUTES = 90;

// How current a reading must be to justify sending an immobilise:
// MAX_ACTIONABLE_FIX_AGE_MS, shared with the curfew, which decides the same
// thing from the same kind of reading.
//
// Far tighter than the ninety minutes above, and deliberately so. The sweep
// allows itself ninety because the last known ping is all it has. A command
// decided from a live report has no such excuse: the tracker is on the other
// end of a socket and its current position is arriving in the same batch,
// milliseconds behind the backlog.
//
// Measured either side of now. A tracker takes its time from GPS, so a fix
// stamped minutes into the future is a unit that has lost its fix and is
// guessing — which is no better a basis for cutting an engine than an
// hour-old record is.

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
 * we cannot see where they are. An offline bike is picked up by onPosition()
 * on its first report inside the window.
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
    `SELECT id, imei, model, bike_id, engine_cut_active
       FROM tracking_devices WHERE night_lock_active = TRUE`);
  let unlocked = 0;
  let leftCut = 0;
  for (const device of rows) {
    try {
      // Rule 2, which this did not keep. lockAll refuses to take over a bike
      // that is already cut, but a bike can be cut AFTER it was night-locked —
      // which is exactly what happens when the curfew confirms a theft at
      // twenty past midnight on a bike locked at midnight. This then restored
      // it at four, because it selected on night_lock_active alone and never
      // looked at why else the engine might be off. A stolen bike's engine
      // came back on a timer. On 14 October that was only avoided because the
      // control room happened to restore the bike by hand at 01:43 first.
      if (device.engine_cut_active) {
        await standDown(device);
        leftCut += 1;
        console.log(`[night-lock] bike ${device.bike_id} left cut — that was somebody's decision, not the timer's`);
        continue;
      }
      await releaseDevice(device);
      unlocked += 1;
    } catch (e) {
      console.error(`[night-lock] could not wake ${device.imei}:`, e.message);
    }
  }
  lastReassert.clear();
  if (rows.length) {
    console.log(`[night-lock] woke ${unlocked} of ${rows.length}${leftCut ? `, left ${leftCut} cut` : ''}`);
  }
  return { unlocked, attempted: rows.length, left_cut: leftCut };
}

/**
 * Let go of a bike without restoring it.
 *
 * For a bike that was night-locked and has since been cut by somebody — the
 * curfew confirming a theft, an operator, an arrears cut. The night lock no
 * longer owns that engine, so it clears its own flag and sends nothing. The
 * bike stays cut, and the person who cut it is the one who decides when it
 * comes back.
 */
async function standDown(device) {
  await pgDb.query(
    'UPDATE tracking_devices SET night_lock_active = FALSE, night_locked_at = NULL WHERE id = $1',
    [device.id]);
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
 * Called on every position a tracker reports.
 *
 * Three jobs, depending on what the bike is and what time it is.
 *
 * Locked, inside the window: if the bike is reporting its ignition on, the
 * lock did not take or somebody has defeated it by cycling the power.
 * Re-send — but only while it is standing still, never to a motorcycle
 * under way.
 *
 * Locked, outside the window: it is daylight and this bike is still locked,
 * which means the four o'clock sweep did not run or did not reach it. Let it
 * go. A cron that fails should not be able to keep a fleet off the road, and
 * the bike reporting in is the most reliable signal available that it is
 * stuck.
 *
 * Not locked, inside the window: this is a bike midnight could not reach,
 * because it was asleep or out of coverage when the sweep ran. lockAll has
 * always said such a bike would be "picked up the moment it reports in" —
 * this is the part that makes that true. It was missing, so on a fleet of 91
 * bikes, 11 were eligible at midnight and simply never got the command.
 *
 * On which clock, and this is the whole of it:
 *
 * What time it is, and when a fix was taken, are not the same question.
 * Teltonika units buffer while they sleep or lose coverage and dump the
 * backlog oldest-first when they next dial in, so a report landing at 00:35
 * can carry a 23:34 timestamp. This decided the window from that timestamp,
 * and so released bikes within minutes of locking them — six on the first
 * night, each logged as "still locked after the window" at half past
 * midnight, and nothing re-locks them because the sweep runs once. The fleet
 * looked like the lock worked on some bikes and not others; what actually
 * differed was which bikes reported during the night.
 *
 * So: the window is asked of the clock. The fix's own timestamp is used for
 * the one thing it can answer — whether this reading is current enough to
 * justify a command, which is a much shorter leash than the sweep's. A
 * record out of the backlog is worth storing and not worth acting on.
 */
async function onPosition({ deviceId, speedKmh, ignitionOn, at = new Date(), now = new Date() }) {
  const { rows } = await pgDb.query(`
    SELECT d.id, d.imei, d.model, d.bike_id, d.night_lock_active, d.engine_cut_active,
           b.status, b.night_curfew_exempt, b.night_curfew_reprieve_until,
           b.night_lock_released_until
      FROM tracking_devices d
      JOIN bikes b ON b.id = d.bike_id
     WHERE d.id = $1`, [deviceId]);
  const device = rows[0];
  if (!device) return null;

  const inWindow = nightCurfew.inCurfew(now);
  const fixIsCurrent = Math.abs(now.getTime() - at.getTime()) <= MAX_ACTIONABLE_FIX_AGE_MS;

  if (device.night_lock_active) {
    if (!inWindow) {
      // Rule 2 again, on the self-heal path. A bike cut for theft that reports
      // in at nine in the morning must not be handed its engine back by this.
      if (device.engine_cut_active) {
        await standDown(device);
        console.log(`[night-lock] bike ${device.bike_id} let go after the window, but left cut — somebody else stopped it`);
        return 'stood_down';
      }
      await releaseDevice(device);
      console.warn(`[night-lock] bike ${device.bike_id} was still locked after the window — released on its own report`);
      return 'self_released';
    }
    if (!fixIsCurrent) return null;

    // Already stopped by somebody who meant it. Re-asserting the night lock on
    // top of a theft cut sends a command that changes nothing.
    if (device.engine_cut_active) return null;

    const movingOrUnknown = speedKmh == null || speedKmh > STATIONARY_KMH;
    if (ignitionOn === true && !movingOrUnknown) {
      const since = now.getTime() - (lastReassert.get(device.id) || 0);
      if (since < REASSERT_INTERVAL_MS) return 'reassert_held';
      lastReassert.set(device.id, now.getTime());
      await send(device.imei, device.id, cutCommandForModel(device.model));
      console.log(`[night-lock] re-asserted on ${device.imei} — it was started while locked`);
      return 'reasserted';
    }
    return null;
  }

  // The bike midnight missed. Every rule the sweep applies applies here too:
  // the feature switched on, no cut somebody else made, covered by the
  // curfew, standing still.
  if (!inWindow || !fixIsCurrent) return null;
  if (!(await isEnabled())) return null;
  if (device.engine_cut_active) return null;
  if (!(await covers(device, now))) return null;

  // Rule 1, asked of the report in hand rather than of the pings table. A
  // speed we were not given is not a bike we lock: unknown is not still.
  const speed = speedKmh == null ? null : Number(speedKmh);
  if (speed == null || speed > STATIONARY_KMH) return null;
  if (ignitionIsOn(ignitionOn)) return null;

  // Claimed before the command is sent, so two records arriving in the same
  // batch cannot both decide to lock the same bike. The tracker is on the
  // other end of a live socket here — this is the one path where the cut is
  // not being queued into the dark.
  const { rowCount } = await pgDb.query(
    `UPDATE tracking_devices SET night_lock_active = TRUE, night_locked_at = NOW()
      WHERE id = $1 AND night_lock_active = FALSE`, [device.id]);
  if (!rowCount) return null;
  await send(device.imei, device.id, cutCommandForModel(device.model));
  console.log(`[night-lock] bike ${device.bike_id} locked on its first report of the window`);
  return 'late_locked';
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
  SETTING_KEY, STATIONARY_KMH, FIX_MAX_AGE_MINUTES, REASSERT_INTERVAL_MS,
  clearReassertMemory,
};
