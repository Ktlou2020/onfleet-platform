'use strict';

// Chases critical tracking alerts (panic, tamper, unauthorised movement, power
// disconnect, night movement, towing, and critical-level theft-risk scores)
// that nobody has acknowledged.
//
// It used to send one email 15 minutes in and stop, and stamp the alert as
// escalated whether or not anything left the server. Tamper alerts were taking
// an average of six hours to be acknowledged, which is several suburbs' worth
// of head start on a stolen bike. Escalation now repeats in rounds until
// somebody acknowledges, and each round reaches further:
//
//   round 1 (5 min)   — email and push to the recipients, WhatsApp (or SMS if
//                       WhatsApp can't carry it) to the duty phone
//   round 2 (15 min)  — the same, and the control room's webhook fires again
//   round 3 (30 min)  — the same
//   round 4 (60 min)  — the same, then it stops chasing
//
// Acknowledging (or closing) an alert ends the chase immediately, which is why
// acknowledging now records who did it. Every attempt is written to
// alert_escalations, so "we were never told" can be answered with a record.
//
// Rounds are persisted on the alert (escalation_round), not held in memory: a
// deploy mid-chase must not restart it from round 1 and re-page everyone.

const pgDb = require('../pgDb');
const { sendNotification } = require('./notifierPg');
const { sendSms, detectSmsProvider, toE164 } = require('./smsProvider');
const { alertContact } = require('./alertContact');

const { ROUNDS_AT_MINUTES, MAX_ROUNDS, WEBHOOK_FROM_ROUND } = require('../constants/alertEscalation');
const { brand } = require('../brand');

const CRITICAL_TYPES = ['panic', 'tamper', 'power_disconnect', 'movement', 'night_movement', 'towing', 'danger_zone_enter'];

const ALERT_LABELS = {
  panic:            'Panic / SOS',
  tamper:           'GPS tamper detected',
  power_disconnect: 'External power disconnected',
  movement:         'Unauthorized movement',
  night_movement:   'Movement during high-theft hours (00:00–04:00)',
  towing:           'Possible towing (ignition off, sustained movement)',
  theft_risk:       'AI theft/anomaly risk',
  danger_zone_enter: 'Entered a no-go zone',
};

// Extra phones to chase, beyond whichever OnFleet line is on duty.
function extraDutyPhones() {
  return String(process.env.ALERT_ESCALATION_PHONES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

async function resolveRecipients(alertType, deviceId) {
  let setting = null;
  if (deviceId != null) {
    const { rows } = await pgDb.query(
      'SELECT * FROM device_alert_settings WHERE device_id=$1 AND alert_type=$2', [deviceId, alertType]);
    setting = rows[0] || null;
  }
  if (!setting) {
    const { rows } = await pgDb.query('SELECT * FROM alert_settings WHERE alert_type=$1', [alertType]);
    setting = rows[0] || null;
  }
  if (setting && setting.notify_enabled === false) return [];

  let customIds = [];
  try { customIds = JSON.parse(setting?.recipient_user_ids || '[]'); } catch { /* ignore */ }
  const { rows } = customIds.length
    ? await pgDb.query('SELECT id, phone FROM users WHERE id = ANY($1) AND deleted_at IS NULL', [customIds])
    : await pgDb.query("SELECT id, phone FROM users WHERE role='superadmin' AND email IS NOT NULL AND deleted_at IS NULL");
  return rows;
}

async function record(alertId, round, channel, target, status, detail = null) {
  await pgDb.query(
    `INSERT INTO alert_escalations (alert_id, round, channel, target, status, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [alertId, round, channel, target, status, detail ? String(detail).slice(0, 500) : null]
  ).catch((e) => console.error('[alert-escalation] could not record attempt:', e.message));
}

// The alerts due a round right now: unacknowledged, unresolved, critical, and
// past the next round's threshold.
async function dueAlerts() {
  const { rows } = await pgDb.query(
    `SELECT ta.*, b.registration
       FROM tracking_alerts ta
       LEFT JOIN bikes b ON b.id = ta.bike_id
      WHERE ta.acknowledged_at IS NULL
        AND ta.resolved_at IS NULL
        AND ta.escalation_round < $2
        AND (ta.alert_type = ANY($1)
             OR (ta.alert_type = 'theft_risk' AND (ta.payload::jsonb ->> 'level') = 'critical'))
      ORDER BY ta.created_at`, [CRITICAL_TYPES, MAX_ROUNDS]);
  const now = Date.now();
  return rows.filter((a) => {
    const dueAt = new Date(a.created_at).getTime() + ROUNDS_AT_MINUTES[a.escalation_round] * 60_000;
    return dueAt <= now;
  });
}

async function escalateOnce(alert) {
  const round = alert.escalation_round + 1;
  const label = ALERT_LABELS[alert.alert_type] || alert.alert_type;
  const reg = alert.registration || `Bike #${alert.bike_id}`;
  const minutesAgo = Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60_000);
  const title = `⏰ Still unacknowledged (${round}): ${label} — ${reg}`;
  const message = `${label} on ${reg} was raised ${minutesAgo} minutes ago (${alert.created_at}) and nobody has acknowledged it.\n\n`
    + `Open the control room to acknowledge or close it. This is escalation ${round} of ${MAX_ROUNDS}.`;
  const sms = `${brand.name} ALERT ${round}/${MAX_ROUNDS}: ${label} on ${reg}, ${minutesAgo} min unacknowledged. Open the control room.`;

  // Claim the round before sending, so two instances can't both page everyone.
  const { rowCount } = await pgDb.query(
    `UPDATE tracking_alerts SET escalation_round = $1, escalated_at = NOW()
      WHERE id = $2 AND escalation_round = $3 AND acknowledged_at IS NULL AND resolved_at IS NULL`,
    [round, alert.id, alert.escalation_round]);
  if (!rowCount) return false;

  const recipients = await resolveRecipients(alert.alert_type, alert.device_id);
  for (const user of recipients) {
    try {
      await sendNotification({ userId: user.id, channel: 'email', type: `gps_escalation_${alert.alert_type}`, title, message, throwOnError: true });
      await record(alert.id, round, 'email', `user:${user.id}`, 'sent');
    } catch (e) {
      await record(alert.id, round, 'email', `user:${user.id}`, 'failed', e.message);
    }
  }

  // The phone: whichever OnFleet line is on duty for the time the alert was
  // raised, plus anyone listed in ALERT_ESCALATION_PHONES, plus the recipients'
  // own numbers. A theft alert has to ring, not just land in an inbox.
  const duty = alertContact(alert.created_at);
  const phones = [...new Set([
    duty.phone,
    ...extraDutyPhones(),
    ...recipients.map((u) => u.phone).filter(Boolean),
  ].map((p) => toE164(p)).filter(Boolean))];
  // WhatsApp first — it is read faster and costs less than an SMS — then SMS
  // for the same number if WhatsApp couldn't carry it.
  const { templateFor, templateVariables } = require('../constants/whatsappTemplates');
  const template = templateFor('alert_escalation');
  const templateValues = {
    round: `${round}/${MAX_ROUNDS}`, alert: label, bike: reg, minutes: String(minutesAgo),
  };
  const smsProviderName = detectSmsProvider().name;
  for (const phone of phones) {
    const viaWhatsApp = await sendSms(phone, sms, {
      whatsapp: true,
      contentSid: template?.sid || null,
      variables: template ? templateVariables('alert_escalation', templateValues) : null,
    });
    await record(alert.id, round, 'whatsapp', phone,
      viaWhatsApp.delivered ? 'sent' : viaWhatsApp.reason === 'no_provider' ? 'skipped' : 'failed',
      viaWhatsApp.delivered ? 'twilio' : (viaWhatsApp.error || viaWhatsApp.reason));
    if (viaWhatsApp.delivered) continue;

    const outcome = await sendSms(phone, sms);
    await record(alert.id, round, 'sms', phone,
      outcome.delivered ? 'sent' : outcome.reason === 'no_provider' ? 'skipped' : 'failed',
      outcome.delivered ? smsProviderName : (outcome.error || outcome.reason));
  }

  // From the second round, the control room's own systems are told again.
  if (round >= WEBHOOK_FROM_ROUND) {
    try {
      const { queueEscalation } = require('./webhookDispatcher');
      const queued = await queueEscalation(alert, round, minutesAgo);
      await record(alert.id, round, 'webhook', `endpoints:${queued}`, queued ? 'sent' : 'skipped');
    } catch (e) {
      await record(alert.id, round, 'webhook', null, 'failed', e.message);
    }
  }
  return true;
}

async function checkUnacknowledgedCriticalAlerts() {
  try {
    const alerts = await dueAlerts();
    let escalated = 0;
    for (const alert of alerts) {
      if (await escalateOnce(alert)) escalated += 1;
    }
    if (escalated) console.log(`[alert-escalation] chased ${escalated} unacknowledged alert(s)`);
    return escalated;
  } catch (e) {
    console.error('[alert-escalation] failed:', e.message);
    return 0;
  }
}

module.exports = {
  checkUnacknowledgedCriticalAlerts,
  ROUNDS_AT_MINUTES,
  MAX_ROUNDS,
  CRITICAL_TYPES,
};
