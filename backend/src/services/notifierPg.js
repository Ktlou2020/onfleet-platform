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

async function sendSMS(to, body) {
  console.log(`[SMS→${to}] ${body}`);
}

async function sendWhatsApp(to, body) {
  console.log(`[WhatsApp→${to}] ${body}`);
}

// No dedicated notifications page exists for fleet-owner roles today —
// send those clicks to the dashboard instead of a 404.
function notificationsUrlForRole(role) {
  if (role === 'rider') return '/notifications';
  if (role === 'admin' || role === 'superadmin') return '/admin/notifications';
  if (String(role || '').startsWith('fleet_owner_')) return '/fleet/app';
  return '/';
}

async function sendNotification({ userId, channel, type, title, message, throwOnError = true }) {
  let user = null;
  if (userId) {
    const { rows } = await pgDb.query('SELECT email, phone, role FROM users WHERE id = $1', [userId]);
    user = rows[0] || null;
  }
  const { rows: inserted } = await pgDb.query(
    `INSERT INTO notifications (user_id, channel, type, title, message, status) VALUES ($1,$2,$3,$4,$5, 'pending') RETURNING id`,
    [userId || null, channel, type, title || null, message]
  );
  const notificationId = inserted[0].id;
  // Every notification also tries push, regardless of its primary channel —
  // riders/fleet owners who opted in get a phone alert for events that would
  // otherwise only show up next time they open the app's Notifications tab.
  // Fire-and-forget: push delivery never affects the primary channel's
  // sent/failed status, since it's a bonus delivery path, not the record.
  if (userId) sendPushToUser(userId, { title: title || type, body: message, url: notificationsUrlForRole(user?.role) }).catch(() => {});
  try {
    if (channel === 'email' && user?.email) await sendEmail(user.email, title || type, message);
    else if (channel === 'sms' && user?.phone) await sendSMS(user.phone, message);
    else if (channel === 'whatsapp' && user?.phone) await sendWhatsApp(user.phone, message);
    await pgDb.query(`UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`, [notificationId]);
  } catch (e) {
    console.error(`[notification:${channel}:${type}]`, e.message);
    await pgDb.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [notificationId]);
    if (throwOnError) throw e;
  }
  return notificationId;
}

module.exports = { sendNotification, sendEmail };
