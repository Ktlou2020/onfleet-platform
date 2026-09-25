'use strict';

const pgDb = require('../pgDb');

// Which trackers are actually worth looking at.
//
// The health list was judging each device on its single most recent ping, with
// no memory and no notion of what the bike was doing. That produced a list
// nobody could act on, dominated by one false positive:
//
//   A Teltonika keeps the last known latitude and longitude in the GPS element
//   while its GNSS receiver is powered down to save battery. A parked bike
//   therefore reports a perfectly good position with `satellites = 0`, and
//   because it is still connected over TCP it counts as active. Every parked
//   bike looked like a broken one — which is most bikes, most of the time.
//
// The contradiction is worth naming, because it is the whole bug. geofenceService
// refuses to act on a fix below four satellites: to it, that ping is data too
// poor to trust. The health list read the identical ping as evidence the device
// is faulty. Same number, opposite meaning. Only one of them can be right, and
// it is the geofence: a low satellite count describes the fix, not the tracker.
//
// So a weak fix is only a fault when the bike was actually trying to navigate —
// moving, or with the ignition on — and stayed that way across several pings.
// A stationary bike contributes no evidence either way and is not reported.

// The same threshold geofencing refuses to act on. Below four satellites a fix
// can be a kilometre out.
const MIN_SATELLITES = 4;

// Teltonika reports GSM on a 0–5 scale; 0–1 is where reporting starts to drop.
const POOR_GSM = 1;

// Above this the bike is moving rather than drifting on a noisy fix.
const MOVING_KMH = 5;

// How many recent pings to judge on, and how many must be bad before this is a
// fault rather than a moment. One bad reading is weather; six is a tracker.
const WINDOW_PINGS = 12;
const MIN_BAD_PINGS = 6;

// Past this, the last thing a tracker said stops describing the present. Its
// satellite count and signal are history, not status, and reporting them as
// current state is how a device that went quiet last week still shows a live
// complaint about its GPS.
const READING_FRESH_MINUTES = 30;

// How long a tracker must stay silent before that is worth reporting.
//
// `deviceStatus` calls a device offline after an hour, which is the right line
// for the map: a bike nobody has heard from in an hour should not be drawn as
// live. It is the wrong line for this list. These units connect, push, and drop
// the link, and a bike parked in a basement, under a carport or simply out of
// coverage goes quiet for a couple of hours as a matter of routine. Reporting
// every one of them filled the health list with devices that came back on their
// own before anybody read the row.
//
// Six hours is long enough that the silence is no longer routine. Below it the
// device is left off the list entirely — the map still shows it offline, which
// is where that belongs.
const OFFLINE_ALERT_HOURS = 6;
const OFFLINE_ALERT_MS = OFFLINE_ALERT_HOURS * 60 * 60 * 1000;

const BATTERY_CRITICAL_PCT = 20;

/** The tracker's own backup cell: 3200 mV empty, 4200 mV full. */
function battPct(mv) {
  if (mv == null) return null;
  return Math.min(100, Math.max(0, Math.round((Number(mv) - 3200) / 10)));
}

/**
 * Recent reporting quality per device, aggregated in the database rather than
 * inferred from one row.
 *
 * `navigating` counts only the pings where the bike was moving or switched on,
 * because those are the only ones that say anything about whether the GPS can
 * get a fix.
 */
async function recentQuality({ db = pgDb, windowPings = WINDOW_PINGS } = {}) {
  const { rows } = await db.query(
    `SELECT td.id AS device_id, td.bike_id, td.imei, td.last_seen_at, td.connected,
            td.health_ack_signature,
            q.pings, q.newest, q.navigating, q.weak_fix_navigating,
            q.weak_gsm, q.latest_gsm, q.latest_batt_mv
       FROM tracking_devices td
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS pings,
                MAX(recorded_at) AS newest,
                COUNT(*) FILTER (WHERE navigating)::int AS navigating,
                COUNT(*) FILTER (WHERE navigating AND COALESCE(satellites, 0) < $2)::int AS weak_fix_navigating,
                COUNT(*) FILTER (WHERE gsm IS NOT NULL AND gsm <= $3)::int AS weak_gsm,
                (ARRAY_AGG(gsm ORDER BY recorded_at DESC) FILTER (WHERE gsm IS NOT NULL))[1] AS latest_gsm,
                (ARRAY_AGG(batt_mv ORDER BY recorded_at DESC) FILTER (WHERE batt_mv IS NOT NULL))[1] AS latest_batt_mv
           FROM (
             SELECT recorded_at, satellites,
                    (COALESCE(speed_kmh, 0) > $4 OR COALESCE(ignition, 0) = 1) AS navigating,
                    NULLIF(NULLIF(io_data, '')::json->>'21', '')::int AS gsm,
                    NULLIF(NULLIF(io_data, '')::json->>'67', '')::int AS batt_mv
               FROM gps_pings
              WHERE bike_id = td.bike_id
              ORDER BY recorded_at DESC
              LIMIT $1
           ) recent
       ) q ON true
      WHERE td.bike_id IS NOT NULL`,
    [windowPings, MIN_SATELLITES, POOR_GSM, MOVING_KMH]);
  return rows;
}

/**
 * Turn one device's recent quality into the reasons worth showing.
 *
 * `status` is the caller's own offline/sleeping/active determination, so this
 * and the map agree on what offline means rather than each deciding again.
 */
function reasonsFor(row, { status, now = new Date() } = {}) {
  const reasons = [];

  // A device that has never reported has no silence to measure, so it is said
  // straight away: that is an installation that did not finish, not a bike out
  // of coverage.
  const silentFor = row.last_seen_at ? now - new Date(row.last_seen_at) : Infinity;

  if (status === 'offline' && silentFor >= OFFLINE_ALERT_MS) {
    // The timestamp travels as a value rather than inside the sentence, so the
    // browser renders it in South African time like every other time on the
    // page instead of showing a UTC ISO string.
    reasons.push({
      key: 'offline',
      text: row.last_seen_at ? 'Offline' : 'Never connected',
      since: row.last_seen_at || null,
      severity: 'high',
    });
  }

  if (!row.bike_id) reasons.push({ key: 'no_bike', text: 'No bike linked', severity: 'low' });

  // Everything below reads the tracker's own recent reports, so it is only
  // meaningful while those reports are recent.
  const newest = row.newest ? new Date(row.newest) : null;
  const fresh = newest && (now - newest) <= READING_FRESH_MINUTES * 60 * 1000;
  if (!fresh) return { reasons, signature: signatureOf(reasons) };

  const pct = battPct(row.latest_batt_mv);
  if (pct != null && pct <= BATTERY_CRITICAL_PCT) {
    reasons.push({ key: 'battery_critical', text: `Internal battery ${pct}%`, severity: 'high' });
  }

  // A weak fix only means something when the bike was trying to navigate. A
  // parked bike with its GNSS asleep reports zero satellites and is fine.
  if (row.navigating >= MIN_BAD_PINGS && row.weak_fix_navigating >= MIN_BAD_PINGS) {
    reasons.push({
      key: 'weak_gps',
      text: `Weak GPS fix while moving (${row.weak_fix_navigating} of last ${row.navigating})`,
      severity: 'medium',
    });
  }

  if (row.weak_gsm >= MIN_BAD_PINGS) {
    reasons.push({
      key: 'poor_signal',
      text: `Poor GSM signal (${row.weak_gsm} of last ${row.pings})`,
      severity: 'medium',
    });
  }

  return { reasons, signature: signatureOf(reasons) };
}

/**
 * What an acknowledgement is against.
 *
 * The keys alone, sorted, so a battery drifting 20% to 5% stays dismissed
 * rather than reappearing on every percentage point. Severity is included
 * because a device getting *worse* should come back, while one getting better
 * should not — the old signature was keys only, so clearing "offline,weak_gps"
 * and then recovering the GPS made the row reappear for being healthier.
 */
function signatureOf(reasons) {
  return reasons
    .filter((r) => r.severity !== 'low')
    .map((r) => `${r.key}:${r.severity}`)
    .sort()
    .join(',');
}

/**
 * The health list: every device with something worth saying, minus the ones
 * already acknowledged at that severity.
 */
async function unhealthyDevices({ statusFor, db = pgDb, now = new Date() } = {}) {
  const rows = await recentQuality({ db });
  const out = [];
  for (const row of rows) {
    const status = statusFor ? statusFor(row) : (row.connected ? 'active' : 'offline');
    const { reasons, signature } = reasonsFor(row, { status, now });
    if (!reasons.length) continue;
    out.push({
      device_id: row.device_id,
      bike_id: row.bike_id,
      imei: row.imei,
      status,
      reasons,
      signature,
      acknowledged: signature !== '' && signature === row.health_ack_signature,
    });
  }
  return out;
}

module.exports = {
  MIN_SATELLITES, POOR_GSM, MOVING_KMH, WINDOW_PINGS, MIN_BAD_PINGS,
  READING_FRESH_MINUTES, OFFLINE_ALERT_HOURS, BATTERY_CRITICAL_PCT,
  battPct, recentQuality, reasonsFor, signatureOf, unhealthyDevices,
};
