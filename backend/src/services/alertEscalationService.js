'use strict';

// Re-notifies on critical tracking alerts (panic, tamper, unauthorized
// movement, power disconnect, night movement, towing, and critical-level
// theft-risk scores) that nobody has acknowledged after a while. A single
// email is easy to miss during exactly the window that matters most — this
// is the safety net for that, not a repeat-nag: each alert escalates at
// most once, tracked by the persisted escalated_at column rather than an
// in-memory timer (the device_offline duplicate-alert bug earlier this
// session was exactly this mistake — don't repeat it here).

const pgDb = require('../pgDb');
const { sendNotification } = require('./notifierPg');

const ESCALATION_DELAY_MS = 15 * 60_000;

const CRITICAL_TYPES = ['panic', 'tamper', 'power_disconnect', 'movement', 'night_movement', 'towing'];

const ALERT_LABELS = {
  panic:            'Panic / SOS',
  tamper:           'GPS tamper detected',
  power_disconnect: 'External power disconnected',
  movement:         'Unauthorized movement',
  night_movement:   'Movement during high-theft hours (00:00–04:00)',
  towing:           'Possible towing (ignition off, sustained movement)',
  theft_risk:       'AI theft/anomaly risk',
};

async function resolveRecipients(alertType, deviceId) {
  let setting = null;
  if (deviceId != null) {
    const { rows } = await pgDb.query(
      'SELECT * FROM device_alert_settings WHERE device_id=$1 AND alert_type=$2', [deviceId, alertType]
    );
    if (rows[0]) setting = rows[0];
  }
  if (!setting) {
    const { rows } = await pgDb.query('SELECT * FROM alert_settings WHERE alert_type=$1', [alertType]);
    if (rows[0]) setting = rows[0];
  }
  if (setting && setting.notify_enabled === false) return [];

  let customIds = [];
  try { customIds = JSON.parse(setting?.recipient_user_ids || '[]'); } catch { /* ignore */ }
  if (customIds.length) {
    const { rows } = await pgDb.query('SELECT id FROM users WHERE id = ANY($1) AND deleted_at IS NULL', [customIds]);
    return rows.map(r => r.id);
  }
  const { rows } = await pgDb.query("SELECT id FROM users WHERE role='superadmin' AND email IS NOT NULL AND deleted_at IS NULL");
  return rows.map(r => r.id);
}

async function checkUnacknowledgedCriticalAlerts() {
  try {
    const { rows: candidates } = await pgDb.query(`
      SELECT ta.*, b.registration
      FROM tracking_alerts ta
      LEFT JOIN bikes b ON b.id = ta.bike_id
      WHERE ta.escalated_at IS NULL
        AND ta.acknowledged_at IS NULL
        AND ta.resolved_at IS NULL
        AND ta.created_at <= NOW() - INTERVAL '${ESCALATION_DELAY_MS / 60_000} minutes'
        AND (
          ta.alert_type = ANY($1)
          OR (ta.alert_type = 'theft_risk' AND (ta.payload::jsonb ->> 'level') = 'critical')
        )
    `, [CRITICAL_TYPES]);

    let escalated = 0;
    for (const alert of candidates) {
      const recipientIds = await resolveRecipients(alert.alert_type, alert.device_id);
      const label = ALERT_LABELS[alert.alert_type] || alert.alert_type;
      const reg = alert.registration || `Bike #${alert.bike_id}`;
      const minutesAgo = Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60_000);
      const title = `⏰ Still unacknowledged: ${label} — ${reg}`;
      const message = `A ${label} alert for ${reg} has not been acknowledged in ${minutesAgo} minutes.\n\nOriginally triggered: ${alert.created_at}`;

      for (const userId of recipientIds) {
        sendNotification({ userId, channel: 'email', type: `gps_escalation_${alert.alert_type}`, title, message, throwOnError: false }).catch(() => {});
      }
      await pgDb.query('UPDATE tracking_alerts SET escalated_at=NOW() WHERE id=$1', [alert.id]);
      escalated++;
    }
    if (escalated) console.log(`[AlertEscalation] escalated ${escalated} unacknowledged critical alert(s)`);
    return escalated;
  } catch (e) {
    console.error('[AlertEscalation] check failed:', e.message);
    return 0;
  }
}

module.exports = { checkUnacknowledgedCriticalAlerts };
