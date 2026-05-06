const db = require('../db');
// Pluggable notification service. Real providers (Twilio, SMTP) can be wired in here.

async function sendEmail(to, subject, body) {
  // TODO integrate SMTP — placeholder
  console.log(`[EMAIL→${to}] ${subject}: ${body}`);
}
async function sendSMS(to, body) {
  // TODO integrate Twilio
  console.log(`[SMS→${to}] ${body}`);
}
async function sendWhatsApp(to, body) {
  // TODO integrate Twilio WhatsApp
  console.log(`[WhatsApp→${to}] ${body}`);
}

async function sendNotification({ userId, channel, type, title, message }) {
  const user = userId ? db.prepare('SELECT email, phone FROM users WHERE id = ?').get(userId) : null;
  const info = db.prepare(`INSERT INTO notifications (user_id, channel, type, title, message, status)
                           VALUES (?,?,?,?,?, 'pending')`).run(userId || null, channel, type, title || null, message);
  try {
    if (channel === 'email' && user?.email) await sendEmail(user.email, title || type, message);
    else if (channel === 'sms' && user?.phone) await sendSMS(user.phone, message);
    else if (channel === 'whatsapp' && user?.phone) await sendWhatsApp(user.phone, message);
    db.prepare(`UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(info.lastInsertRowid);
  } catch (e) {
    db.prepare(`UPDATE notifications SET status = 'failed' WHERE id = ?`).run(info.lastInsertRowid);
  }
  return info.lastInsertRowid;
}

module.exports = { sendNotification };
