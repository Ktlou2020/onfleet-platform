'use strict';

// Web push delivery — the browser-native equivalent of a mobile push
// notification, using the VAPID keys in PUSH_VAPID_PUBLIC_KEY /
// PUSH_VAPID_PRIVATE_KEY. Fired alongside every sendNotification() call (see
// notifierPg.js) so existing notification events — payment reminders,
// application decisions, collections escalations — reach subscribed devices
// without every call site needing to know push exists.

const webpush = require('web-push');
const pgDb = require('../pgDb');

const publicKey = process.env.PUSH_VAPID_PUBLIC_KEY || '';
const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY || '';
const configured = !!(publicKey && privateKey);

if (configured) {
  webpush.setVapidDetails('mailto:support@onfleet.africa', publicKey, privateKey);
}

function isPushConfigured() {
  return configured;
}

function getPublicKey() {
  return publicKey;
}

async function sendPushToUser(userId, { title, body, url }) {
  if (!configured || !userId) return;
  const { rows: subs } = await pgDb.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (!subs.length) return;

  const payload = JSON.stringify({ title: title || 'OnFleet', body: body || '', url: url || '/' });

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      await pgDb.query('UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = $1', [sub.id]);
    } catch (e) {
      // 404/410 = the browser revoked or expired this subscription — stop trying it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await pgDb.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      } else {
        console.error(`[webPush:${userId}]`, e.message);
      }
    }
  }));
}

module.exports = { isPushConfigured, getPublicKey, sendPushToUser };
