'use strict';

const pgDb = require('../pgDb');
const { cutCommandForModel } = require('./engineCommands');
const { ALERT_SEVERITY } = require('../constants/alertTypes');
const { notifyRiderEngineState } = require('./engineCutNotifier');

// Cutting a bike's engine without a person deciding to.
//
// There are two things that do this — entering a no-go zone, and moving during
// the overnight curfew — and they must behave identically, because what
// matters afterwards is the same in both cases: the cut is recorded with its
// reason, it survives the bike's battery being pulled, somebody is told, and
// the rider standing next to a bike that just died knows why and who to call.
//
// engine_cut_by stays NULL: that column answers "which person did this", and
// for these the answer is nobody. The reason column carries the why.

async function autoCut({ deviceId, bikeId, reason, riderReason, payload = {} }) {
  try {
    const { rows } = await pgDb.query(
      'SELECT id, imei, model, engine_cut_active FROM tracking_devices WHERE id = $1', [deviceId]);
    const device = rows[0];
    if (!device) return false;

    // Already cut — re-sending would be harmless but would raise a second
    // alert for a bike that is already stopped, and bury the first one.
    if (device.engine_cut_active) return false;

    const cutCmd = cutCommandForModel(device.model);
    const { rows: cmdRows } = await pgDb.query(
      `INSERT INTO tracking_commands (device_id, command, status, created_at)
       VALUES ($1, $2, 'pending', NOW()) RETURNING id`, [deviceId, cutCmd]);
    const cmdId = cmdRows[0].id;

    // Persisted before the command is sent, not after: setdigout does not
    // survive a power cycle, and this flag is what teltonikaServer re-asserts
    // on every reconnect. A cut that was sent but not recorded would be
    // defeated by pulling the battery.
    await pgDb.query(
      `UPDATE tracking_devices SET engine_cut_active=TRUE, engine_cut_reason=$1, engine_cut_at=NOW(), engine_cut_by=NULL WHERE id=$2`,
      [reason, deviceId]);

    // Lazy require — teltonikaServer requires this module's callers.
    const { sendCommand } = require('../tcp/teltonikaServer');
    const sent = sendCommand(device.imei, cmdId, cutCmd);
    console.log(`[auto-cut] ${sent ? 'sent' : 'queued'} for ${device.imei} — ${reason}`);

    const alertPayload = { ...payload, reason, cmd: cutCmd, queued: !sent };
    const { rows: alertRows } = await pgDb.query(
      `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, severity, payload, created_at)
       VALUES ($1,$2,'engine_cut_auto',$3,$4,NOW()) RETURNING id`,
      [bikeId, deviceId, ALERT_SEVERITY.engine_cut_auto, JSON.stringify(alertPayload)]);

    // Through emitAlert rather than a bare event so the most urgent thing the
    // platform does on its own actually reaches a human by email.
    const { emitAlert } = require('./tripService');
    await emitAlert(alertRows[0].id, bikeId, deviceId, 'engine_cut_auto', alertPayload, new Date().toISOString());

    // The rider is the one standing next to a bike that just stopped working.
    notifyRiderEngineState(bikeId, 'cut', { reason: riderReason || reason, automatic: true })
      .catch((e) => console.error('[auto-cut] rider notify failed:', e.message));

    return true;
  } catch (e) {
    console.error('[auto-cut] failed:', e.message);
    return false;
  }
}

module.exports = { autoCut };
