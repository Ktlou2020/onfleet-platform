'use strict';

// Daily internal-battery health check for tracking devices.
//
// A single battery reading can't tell a healthy backup cell from one about
// to fail — but a steady decline over several days is a strong early-warning
// signal, and this is the one power source that keeps a tracker reporting
// after grid/vehicle power is cut (e.g. during a theft attempt), so it's
// worth catching before it dies rather than after.

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');

// Mirrors battPct() in frontend/src/pages/admin/Tracking.jsx — the tracker's
// own backup cell, roughly 3.2V (0%) to 4.2V (100%) for a single-cell Li-ion.
function battPct(mv) { return Math.min(100, Math.max(0, Math.round((mv - 3200) / 10))); }

const DECLINE_WINDOW_DAYS = 5;
const DECLINE_THRESHOLD_PCT = 15; // total drop across the window worth flagging
const ALERT_COOLDOWN_DAYS = 7; // don't refire every day once a device is flagged

// One row per device-with-a-bike: parse the internal battery (io[67], per
// the corrected Teltonika field mapping) out of its most recent ping today.
async function snapshotBatteries() {
  const { rows } = await pgDb.query(`
    SELECT td.id AS device_id, p.io_data
    FROM tracking_devices td
    JOIN LATERAL (
      SELECT io_data FROM gps_pings WHERE bike_id = td.bike_id ORDER BY recorded_at DESC LIMIT 1
    ) p ON true
    WHERE td.bike_id IS NOT NULL
  `);

  let snapshotted = 0;
  for (const row of rows) {
    let io;
    try { io = JSON.parse(row.io_data || '{}'); } catch { continue; }
    const battMv = io[67] != null ? Number(io[67]) : null;
    if (battMv == null) continue;
    await pgDb.query(
      `INSERT INTO device_battery_history (device_id, battery_pct, recorded_at)
       VALUES ($1, $2, CURRENT_DATE)
       ON CONFLICT (device_id, recorded_at) DO UPDATE SET battery_pct = EXCLUDED.battery_pct`,
      [row.device_id, battPct(battMv)]
    );
    snapshotted++;
  }
  return snapshotted;
}

async function isAlertEnabled(alertType) {
  const { rows } = await pgDb.query('SELECT enabled FROM alert_settings WHERE alert_type=$1', [alertType]);
  return rows[0] ? rows[0].enabled !== false : true;
}

async function checkDeclines() {
  if (!(await isAlertEnabled('battery_declining'))) return 0;

  const { rows: histories } = await pgDb.query(
    `SELECT device_id, array_agg(battery_pct ORDER BY recorded_at ASC) AS pcts
     FROM device_battery_history
     WHERE recorded_at >= CURRENT_DATE - INTERVAL '${DECLINE_WINDOW_DAYS - 1} days'
     GROUP BY device_id
     HAVING COUNT(*) >= $1`,
    [DECLINE_WINDOW_DAYS]
  );

  let fired = 0;
  for (const { device_id, pcts } of histories) {
    const from = pcts[0];
    const to = pcts[pcts.length - 1];
    const drop = from - to;
    if (drop < DECLINE_THRESHOLD_PCT) continue;

    const { rows: cooldownRows } = await pgDb.query(
      `SELECT id FROM tracking_alerts
       WHERE device_id = $1 AND alert_type = 'battery_declining' AND created_at >= NOW() - INTERVAL '${ALERT_COOLDOWN_DAYS} days'
       LIMIT 1`,
      [device_id]
    );
    if (cooldownRows.length) continue;

    const { rows: devRows } = await pgDb.query('SELECT bike_id FROM tracking_devices WHERE id=$1', [device_id]);
    const bikeId = devRows[0]?.bike_id;
    if (!bikeId) continue;

    const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id=$1', [bikeId]);
    const reg = bikeRows[0]?.registration || null;

    const payload = JSON.stringify({ from_pct: from, to_pct: to, days: DECLINE_WINDOW_DAYS });
    const { rows: alertRows } = await pgDb.query(
      `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at)
       VALUES ($1,$2,'battery_declining',$3,NOW()) RETURNING id`,
      [bikeId, device_id, payload]
    );

    trackingEvents.emit('alert', {
      id: alertRows[0].id,
      bike_id: bikeId,
      device_id,
      alert_type: 'battery_declining',
      payload,
      bike_registration: reg,
      created_at: new Date().toISOString(),
      acknowledged_at: null,
    });
    fired++;
  }
  return fired;
}

async function runBatteryHealthCheck() {
  const snapshotted = await snapshotBatteries();
  const fired = await checkDeclines();
  console.log(`[BatteryHealth] snapshotted ${snapshotted} device(s), ${fired} decline alert(s) fired`);
}

module.exports = { runBatteryHealthCheck, snapshotBatteries, checkDeclines };
