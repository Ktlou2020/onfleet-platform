'use strict';

// Proving a tracker actually works, and keeping score of the fleet's trackers
// as a whole.
//
// Five trackers registered on one morning had never sent a byte, and nothing
// said so until someone went looking. The checks below are all answerable from
// data the tracker itself sends, so an installer can see, at the bike, whether
// the unit is really installed — rather than everyone finding out when a bike
// goes missing and there is no trail.

const pgDb = require('../pgDb');

const SILENT_AFTER_MINUTES = Number(process.env.TRACKER_SILENT_AFTER_MINUTES) || 60;
const STALE_INSTALL_HOURS = 24;

function parseIo(io) {
  if (!io) return {};
  try { return typeof io === 'string' ? JSON.parse(io) : io; } catch { return {}; }
}

// Each check says what it is, whether it passed, and what was seen — a red
// cross with no reading is no use to an installer standing in the rain.
function buildChecks(device, ping, ioRow) {
  const io = parseIo(ping?.io_data);
  const lastSeen = device.last_seen_at ? new Date(device.last_seen_at) : null;
  const minutesSince = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 60_000) : null;
  const battMv = io[67] != null ? Number(io[67]) : null;
  const extMv = io[66] != null ? Number(io[66]) : null;
  const gsm = io[21] != null ? Number(io[21]) : null;

  return [
    {
      id: 'connected', label: 'Tracker has reached the server', required: true,
      passed: !!lastSeen,
      detail: lastSeen ? `Last seen ${minutesSince} min ago` : 'Never connected — check power, SIM data and that it points at the OnFleet server',
    },
    {
      id: 'reporting', label: 'Reporting now', required: true,
      passed: minutesSince != null && minutesSince <= SILENT_AFTER_MINUTES,
      detail: minutesSince == null ? 'No pings yet' : `Last ping ${minutesSince} min ago`,
    },
    {
      id: 'gps_fix', label: 'Has a GPS fix', required: true,
      passed: !!(ping && ping.lat && ping.lng && (ping.satellites == null || ping.satellites >= 3)),
      detail: ping?.lat ? `${Number(ping.lat).toFixed(5)}, ${Number(ping.lng).toFixed(5)}${ping.satellites != null ? ` · ${ping.satellites} satellites` : ''}` : 'No position yet — park the bike where it can see sky',
    },
    {
      id: 'power', label: 'Wired to the bike\'s power', required: true,
      passed: extMv != null && extMv > 9000,
      detail: extMv == null ? 'No external voltage reported' : `${(extMv / 1000).toFixed(1)} V`,
    },
    {
      id: 'ignition', label: 'Ignition line connected', required: false,
      passed: io[239] != null,
      detail: io[239] == null ? 'No ignition signal — trips will be guessed from movement instead' : `Ignition ${Number(io[239]) ? 'on' : 'off'}`,
    },
    {
      id: 'battery', label: 'Backup battery charged', required: false,
      passed: battMv != null && battMv >= 3600,
      detail: battMv == null ? 'No battery reading' : `${battMv} mV`,
    },
    {
      id: 'signal', label: 'Mobile signal', required: false,
      passed: gsm != null && gsm >= 2,
      detail: gsm == null ? 'No signal reading' : `${gsm} of 5`,
    },
    {
      id: 'bike', label: 'Linked to a bike', required: true,
      passed: !!device.bike_id,
      detail: device.registration ? `Linked to ${device.registration}` : 'Not linked to any bike',
    },
    {
      id: 'moved', label: 'Recorded a trip', required: false,
      passed: Number(ioRow?.trips || 0) > 0,
      detail: Number(ioRow?.trips || 0) > 0 ? `${ioRow.trips} trip(s) recorded` : 'No trip yet — ride the bike around the block',
    },
  ];
}

async function runChecks(deviceId) {
  const { rows } = await pgDb.query(
    `SELECT d.*, b.registration FROM tracking_devices d LEFT JOIN bikes b ON b.id = d.bike_id WHERE d.id = $1`, [deviceId]);
  const device = rows[0];
  if (!device) return null;

  const { rows: pings } = device.bike_id
    ? await pgDb.query(
      `SELECT lat, lng, satellites, io_data, recorded_at FROM gps_pings WHERE bike_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
      [device.bike_id])
    : { rows: [] };
  const { rows: trips } = device.bike_id
    ? await pgDb.query('SELECT COUNT(*)::int AS trips FROM trips WHERE bike_id = $1', [device.bike_id])
    : { rows: [{ trips: 0 }] };

  const checks = buildChecks(device, pings[0], trips[0]);
  const { rows: signOff } = await pgDb.query('SELECT * FROM device_commissioning WHERE device_id = $1', [deviceId]);
  return {
    device: {
      id: device.id, imei: device.imei, model: device.model, bike_id: device.bike_id,
      registration: device.registration, last_seen_at: device.last_seen_at, created_at: device.created_at,
    },
    checks,
    ready: checks.filter((c) => c.required).every((c) => c.passed),
    commissioning: signOff[0] || null,
  };
}

async function commission({ deviceId, actorId, notes = null, overrideReason = null }) {
  const result = await runChecks(deviceId);
  if (!result) return { error: 'Device not found' };
  if (!result.ready && !overrideReason) {
    const failed = result.checks.filter((c) => c.required && !c.passed).map((c) => c.label);
    return { error: `Not ready yet: ${failed.join(', ')}. Fix these, or sign off with a reason.`, checks: result.checks };
  }
  const { rows } = await pgDb.query(
    `INSERT INTO device_commissioning (device_id, commissioned_at, commissioned_by, checks, override_reason, notes, updated_at)
     VALUES ($1, NOW(), $2, $3, $4, $5, NOW())
     ON CONFLICT (device_id) DO UPDATE
       SET commissioned_at = NOW(), commissioned_by = EXCLUDED.commissioned_by, checks = EXCLUDED.checks,
           override_reason = EXCLUDED.override_reason, notes = EXCLUDED.notes, updated_at = NOW()
     RETURNING *`,
    [deviceId, actorId, JSON.stringify(result.checks), overrideReason, notes]);
  return { commissioning: rows[0], checks: result.checks };
}

// The fleet's trackers as one picture: what is reporting, what has gone quiet,
// what was never installed properly. This is the service level the tracking
// platform is actually delivering.
async function fleetHealth() {
  const { rows: devices } = await pgDb.query(
    `SELECT d.id, d.imei, d.model, d.firmware_version, d.last_seen_at, d.created_at, d.bike_id,
            b.registration, b.status AS bike_status,
            dc.commissioned_at, dc.override_reason,
            (SELECT io_data FROM gps_pings WHERE bike_id = d.bike_id ORDER BY recorded_at DESC LIMIT 1) AS io_data
       FROM tracking_devices d
       LEFT JOIN bikes b ON b.id = d.bike_id
       LEFT JOIN device_commissioning dc ON dc.device_id = d.id
      ORDER BY d.last_seen_at DESC NULLS LAST`);

  const now = Date.now();
  const enriched = devices.map((d) => {
    const io = parseIo(d.io_data);
    const minutes = d.last_seen_at ? Math.round((now - new Date(d.last_seen_at).getTime()) / 60_000) : null;
    const state = minutes == null ? 'never_connected'
      : minutes <= SILENT_AFTER_MINUTES ? 'reporting'
      : minutes <= 24 * 60 ? 'quiet'
      : 'silent';
    return {
      ...d, io_data: undefined,
      minutes_since_ping: minutes,
      state,
      battery_mv: io[67] != null ? Number(io[67]) : null,
      external_mv: io[66] != null ? Number(io[66]) : null,
      gsm: io[21] != null ? Number(io[21]) : null,
      commissioned: !!d.commissioned_at,
      // A tracker registered more than a day ago that nobody has signed off
      installed: !!d.commissioned_at || (now - new Date(d.created_at).getTime()) < STALE_INSTALL_HOURS * 3600_000,
    };
  });

  const count = (fn) => enriched.filter(fn).length;
  return {
    devices: enriched,
    summary: {
      total: enriched.length,
      reporting: count((d) => d.state === 'reporting'),
      quiet: count((d) => d.state === 'quiet'),
      silent: count((d) => d.state === 'silent'),
      never_connected: count((d) => d.state === 'never_connected'),
      uncommissioned: count((d) => !d.commissioned),
      awaiting_install_proof: count((d) => !d.installed),
      on_inactive_bikes: count((d) => d.bike_id && d.bike_status !== 'active'),
      unlinked: count((d) => !d.bike_id),
      // The number worth reporting: trackers that did their job in the last hour
      reporting_pct: enriched.length ? Math.round((count((d) => d.state === 'reporting') / enriched.length) * 100) : null,
    },
  };
}

module.exports = { runChecks, commission, fleetHealth, buildChecks, SILENT_AFTER_MINUTES, STALE_INSTALL_HOURS };
