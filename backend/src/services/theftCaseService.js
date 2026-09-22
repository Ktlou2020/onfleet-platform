'use strict';

// The theft playbook. Alerts that suggest a bike is being taken open a case
// automatically; everything that happens to that bike while the case is open
// is gathered onto it; and closing it records what actually happened. Before
// this, a tamper alert was a line in a list and the rest of the story lived in
// somebody's memory — which is why the platform can say 85 bikes are stolen
// but not how many were recovered.
//
// While a case is open the tracker is asked for its position more often than
// its own reporting interval, so the trail doesn't go cold between pings. That
// costs SIM data, so it is time-boxed (FOLLOW_MINUTES) and only asked of a
// device that is actually connected.

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const teltonikaServer = require('../tcp/teltonikaServer');

// Alerts that mean "this bike may be being taken right now".
const OPENING_TYPES = new Set(['tamper', 'towing', 'movement', 'night_movement', 'power_disconnect']);

const FOLLOW_MINUTES = Number(process.env.THEFT_FOLLOW_MINUTES) || 60;
const FOLLOW_INTERVAL_MS = (Number(process.env.THEFT_FOLLOW_INTERVAL_SEC) || 60) * 1000;

const OPEN_STATUSES = ['open', 'with_police'];
const CLOSED_STATUSES = ['recovered', 'false_alarm', 'written_off'];

function isOpeningAlert(alert) {
  if (!alert || !alert.bike_id) return false;
  if (OPENING_TYPES.has(alert.alert_type)) return true;
  if (alert.alert_type !== 'theft_risk') return false;
  let payload = {};
  try { payload = typeof alert.payload === 'string' ? JSON.parse(alert.payload || '{}') : (alert.payload || {}); }
  catch { payload = {}; }
  return payload.level === 'critical';
}

async function addEvent(caseId, kind, summary, detail = null, actorId = null, db = pgDb) {
  const { rows } = await db.query(
    `INSERT INTO theft_case_events (case_id, kind, summary, detail, actor_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [caseId, kind, summary, detail ? JSON.stringify(detail) : null, actorId]);
  return rows[0];
}

// Opens a case for a bike, or attaches to the one already open. Returns
// { theftCase, created }.
async function openCase({ bikeId, deviceId = null, alertId = null, reason, actorId = null, follow = true }) {
  const { rows: existing } = await pgDb.query(
    `SELECT * FROM theft_cases WHERE bike_id = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 1`,
    [bikeId, OPEN_STATUSES]);
  if (existing[0]) {
    if (alertId) {
      await addEvent(existing[0].id, 'alert', reason, { alert_id: alertId });
    }
    return { theftCase: existing[0], created: false };
  }

  const followUntil = follow ? new Date(Date.now() + FOLLOW_MINUTES * 60_000) : null;
  const { rows } = await pgDb.query(
    `INSERT INTO theft_cases (bike_id, device_id, trigger_alert_id, opened_by, opened_reason, follow_until)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [bikeId, deviceId, alertId, actorId, reason, followUntil]);
  const theftCase = rows[0];
  await addEvent(theftCase.id, 'opened', reason, { alert_id: alertId, automatic: !actorId }, actorId);
  console.log(`[theft-case] opened #${theftCase.id} for bike ${bikeId}: ${reason}`);
  return { theftCase, created: true };
}

async function closeCase({ caseId, status, note = null, policeReference = null, actorId }) {
  if (!CLOSED_STATUSES.includes(status)) throw new Error(`Cannot close a case as "${status}"`);
  const { rows } = await pgDb.query(
    `UPDATE theft_cases
        SET status = $1, closing_note = $2, police_reference = COALESCE($3, police_reference),
            closed_at = NOW(), closed_by = $4, follow_until = NULL, updated_at = NOW()
      WHERE id = $5 AND closed_at IS NULL
      RETURNING *`,
    [status, note, policeReference, actorId, caseId]);
  if (!rows[0]) return null;
  await addEvent(caseId, 'closed', `Closed as ${status.replace(/_/g, ' ')}`, { status, note }, actorId);
  return rows[0];
}

async function setStatus({ caseId, status, policeReference = null, actorId }) {
  if (!OPEN_STATUSES.includes(status)) throw new Error(`"${status}" is not a status an open case can take`);
  const { rows } = await pgDb.query(
    `UPDATE theft_cases SET status = $1, police_reference = COALESCE($2, police_reference), updated_at = NOW()
      WHERE id = $3 AND closed_at IS NULL RETURNING *`,
    [status, policeReference, caseId]);
  if (!rows[0]) return null;
  await addEvent(caseId, 'status', `Marked ${status.replace(/_/g, ' ')}`, { status, police_reference: policeReference }, actorId);
  return rows[0];
}

async function extendFollow(caseId, minutes, actorId) {
  const until = new Date(Date.now() + minutes * 60_000);
  const { rows } = await pgDb.query(
    `UPDATE theft_cases SET follow_until = $1, updated_at = NOW() WHERE id = $2 AND closed_at IS NULL RETURNING *`,
    [until, caseId]);
  if (!rows[0]) return null;
  await addEvent(caseId, 'follow', `Live follow extended by ${minutes} minutes`, { until }, actorId);
  return rows[0];
}

async function stopFollow(caseId, actorId) {
  const { rows } = await pgDb.query(
    `UPDATE theft_cases SET follow_until = NULL, updated_at = NOW() WHERE id = $1 AND closed_at IS NULL RETURNING *`, [caseId]);
  if (!rows[0]) return null;
  await addEvent(caseId, 'follow', 'Live follow stopped', null, actorId);
  return rows[0];
}

// Every alert on a bike with an open case is added to that case's story.
async function onAlert(alert) {
  try {
    if (!alert?.bike_id) return;
    const { rows } = await pgDb.query(
      `SELECT id FROM theft_cases WHERE bike_id = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 1`,
      [alert.bike_id, OPEN_STATUSES]);
    if (rows[0]) {
      await addEvent(rows[0].id, 'alert', alert.alert_type.replace(/_/g, ' '), { alert_id: alert.id, payload: alert.payload });
      return;
    }
    if (!isOpeningAlert(alert)) return;
    await openCase({
      bikeId: alert.bike_id,
      deviceId: alert.device_id || null,
      alertId: alert.id,
      reason: `Opened automatically by a ${alert.alert_type.replace(/_/g, ' ')} alert`,
    });
  } catch (e) {
    console.error('[theft-case] could not handle alert:', e.message);
  }
}

// Ask the trackers on open cases where they are, more often than they would
// report on their own. Only connected devices are asked, and only while the
// case's follow window is open.
async function casesToFollow() {
  const { rows } = await pgDb.query(
    `SELECT tc.id, tc.bike_id, td.id AS device_id, td.imei
       FROM theft_cases tc
       JOIN tracking_devices td ON td.id = COALESCE(tc.device_id, (SELECT id FROM tracking_devices WHERE bike_id = tc.bike_id LIMIT 1))
      WHERE tc.status = ANY($1) AND tc.follow_until IS NOT NULL AND tc.follow_until > NOW()`, [OPEN_STATUSES]);
  return rows;
}

async function followOpenCases() {
  const rows = await casesToFollow();
  if (!rows.length) return 0;

  const connected = new Set(teltonikaServer.getConnectedIMEIs());
  let asked = 0;
  for (const row of rows) {
    if (!connected.has(row.imei)) continue;
    try {
      const { rows: cmd } = await pgDb.query(
        `INSERT INTO tracking_commands (device_id, command, created_by) VALUES ($1,'getgps',NULL) RETURNING id`, [row.device_id]);
      teltonikaServer.sendCommand(row.imei, cmd[0].id, 'getgps');
      asked += 1;
    } catch (e) {
      console.error('[theft-case] follow failed for', row.imei, e.message);
    }
  }
  return asked;
}

let followTimer = null;
function start() {
  trackingEvents.on('alert', (alert) => { onAlert(alert).catch(() => {}); });
  if (!followTimer) {
    followTimer = setInterval(() => followOpenCases().catch((e) => console.error('[theft-case]', e.message)), FOLLOW_INTERVAL_MS);
    followTimer.unref?.();
  }
  console.log('🚨 Theft case watch started');
}

module.exports = {
  start, onAlert, openCase, closeCase, setStatus, extendFollow, stopFollow, followOpenCases, casesToFollow, addEvent,
  isOpeningAlert, OPENING_TYPES, OPEN_STATUSES, CLOSED_STATUSES, FOLLOW_MINUTES,
};
