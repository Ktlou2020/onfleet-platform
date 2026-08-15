'use strict';

// Batches critical GPS alert emails so a burst of alerts (several bikes going
// critical within a short window) reaches a recipient as one summary email
// instead of one per alert. Push notifications are unaffected — those still
// fire immediately per-alert from notifierPg.sendNotification, since a phone
// alert is cheap and time-sensitive; only the inbox-noisy email channel is
// batched here.
//
// In-memory only, deliberately: losing the buffer on a deploy just means a
// batch's alerts send as individual emails instead of combined — not lost,
// not duplicated, not a repeat-nag. That's a different failure shape from the
// device_offline cooldown bug earlier this session (where losing in-memory
// state caused duplicate spam), so persisting this isn't warranted.

const pgDb = require('../pgDb');
const { sendEmail } = require('./notifier');

const DIGEST_WINDOW_MS = 90 * 1000;

// email -> { items: [{ notificationId, title, message }], timer }
const buffers = new Map();

function queueDigestEmail(notificationId, email, title, message) {
  if (!email) return;
  let buf = buffers.get(email);
  if (!buf) {
    buf = { items: [], timer: null };
    buffers.set(email, buf);
  }
  buf.items.push({ notificationId, title, message });
  if (!buf.timer) {
    buf.timer = setTimeout(() => flush(email).catch(e => console.error('[AlertDigest]', e.message)), DIGEST_WINDOW_MS);
  }
}

async function flush(email) {
  const buf = buffers.get(email);
  if (!buf) return;
  buffers.delete(email);
  const { items } = buf;
  if (!items.length) return;

  const ids = items.map(i => i.notificationId);
  try {
    if (items.length === 1) {
      await sendEmail(email, items[0].title, items[0].message);
    } else {
      const title = `🚨 ${items.length} fleet alerts need attention`;
      const message = items.map((it, i) => `${i + 1}. ${it.title}\n${it.message}`).join('\n\n---\n\n');
      await sendEmail(email, title, message);
    }
    await pgDb.query(`UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = ANY($1)`, [ids]);
  } catch (e) {
    console.error(`[AlertDigest] send to ${email} failed:`, e.message);
    await pgDb.query(`UPDATE notifications SET status = 'failed' WHERE id = ANY($1)`, [ids]).catch(() => {});
  }
}

module.exports = { queueDigestEmail };
