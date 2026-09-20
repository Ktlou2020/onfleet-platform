'use strict';

// Postgres equivalent of notifier.js's sendNotification (the only DB-touching
// export there) — for callers migrated off SQLite. sendEmail/sendHtmlEmail
// touch no database (pure delivery via Brevo/SMTP/console) and are reused
// directly from the original module.
//
// tripService.js and riskService.js were migrated to Postgres earlier this
// session but kept calling the SQLite sendNotification — a real latent bug
// (looking up a Postgres-sourced userId in SQLite's users table), fixed here
// by switching both to this module.

const pgDb = require('../pgDb');
const { sendEmail } = require('./notifier');
const { sendPushToUser } = require('./webPush');
const { queueDigestEmail } = require('./alertDigestService');

// Neither of these has a provider behind it yet. They used to return quietly,
// and a quiet return is indistinguishable from a successful send — which is how
// 42,707 WhatsApp messages and 1,266 SMS came to be recorded as delivered, with
// a sent_at timestamp, without a single one leaving the server. They now say
// what actually happened, and the caller records that instead.
//
// When a provider is wired up, return { delivered: true } on a successful send.
// A provider is wired up now (services/smsProvider.js). With no credentials
// configured it still reports 'no_provider' and the row still says 'skipped' —
// the honesty above is unchanged, it is just no longer the only outcome.
const { sendSms } = require('./smsProvider');

async function sendSMS(to, body) {
  return sendSms(to, body);
}

async function sendWhatsApp(to, body) {
  return sendSms(to, body, { whatsapp: true });
}

// No dedicated notifications page exists for fleet-owner roles today —
// send those clicks to the dashboard instead of a 404.
function notificationsUrlForRole(role) {
  if (role === 'rider') return '/notifications';
  if (role === 'admin' || role === 'superadmin') return '/admin/notifications';
  if (String(role || '').startsWith('fleet_owner_')) return '/fleet/app';
  return '/';
}

async function sendNotification({ userId, channel, type, title, message, entityType = null, entityId = null, throwOnError = true, digest = false }) {
  let user = null;
  if (userId) {
    const { rows } = await pgDb.query('SELECT email, phone, role FROM users WHERE id = $1', [userId]);
    user = rows[0] || null;
  }
  const { rows: inserted } = await pgDb.query(
    `INSERT INTO notifications (user_id, channel, type, title, message, entity_type, entity_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7, 'pending') RETURNING id`,
    [userId || null, channel, type, title || null, message, entityType, entityId]
  );
  const notificationId = inserted[0].id;
  // Every notification also tries push, regardless of its primary channel —
  // riders/fleet owners who opted in get a phone alert for events that would
  // otherwise only show up next time they open the app's Notifications tab.
  // Fire-and-forget: push delivery never affects the primary channel's
  // sent/failed status, since it's a bonus delivery path, not the record.
  if (userId) sendPushToUser(userId, { title: title || type, body: message, url: notificationsUrlForRole(user?.role) }).catch(() => {});

  // Digest mode: hand the email off to be batched with any other alerts for
  // the same recipient in the next short window, instead of sending it now.
  // Only meaningful for email — push above already fired immediately.
  if (digest && channel === 'email') {
    if (user?.email) {
      queueDigestEmail(notificationId, user.email, title || type, message);
    } else {
      await pgDb.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [notificationId]);
    }
    return notificationId;
  }

  try {
    // Every branch below has to say whether anything was actually delivered.
    // The status used to be written unconditionally after this chain, so a
    // channel that matched nothing at all — a WhatsApp message to one of the
    // 320 riders with no phone number — was still recorded as sent. 722 rows
    // claim a delivery that was never even attempted.
    let outcome;
    if (channel === 'email' && user?.email) {
      await sendEmail(user.email, title || type, message);
      outcome = { delivered: true };
    } else if (channel === 'sms' && user?.phone) {
      outcome = await sendSMS(user.phone, message);
    } else if (channel === 'whatsapp' && user?.phone) {
      outcome = await sendWhatsApp(user.phone, message);
    } else if (channel === 'in_app') {
      outcome = { delivered: true };   // the row itself is the delivery
    } else {
      outcome = { delivered: false, reason: 'no_contact_detail' };
    }

    // 'skipped' is not a failure: the message was composed and is on file, and
    // there is simply no channel to carry it. Keeping that separate from
    // 'failed' is what lets you see how much of the backlog turns real the day
    // a provider is connected.
    const status = outcome.delivered ? 'sent'
      : outcome.reason === 'no_provider' ? 'skipped'
      : 'failed';
    await pgDb.query(
      `UPDATE notifications SET status = $1, sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE NULL END WHERE id = $2`,
      [status, notificationId]);
  } catch (e) {
    console.error(`[notification:${channel}:${type}]`, e.message);
    await pgDb.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [notificationId]);
    if (throwOnError) throw e;
  }
  return notificationId;
}

module.exports = { sendNotification, sendEmail };
