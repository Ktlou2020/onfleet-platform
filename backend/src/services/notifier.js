const nodemailer = require('nodemailer');
const db = require('../db');

let transporter;

function getTransporter() {
  if (transporter !== undefined) return transporter;

  const host = (process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';

  if (!host) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined
  });

  return transporter;
}

function toHtml(body) {
  return String(body || '')
    .split('\n')
    .map((line) => `<p style="margin:0 0 12px">${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('');
}

async function sendEmail(to, subject, body) {
  const emailTo = String(to || '').trim();
  if (!emailTo) return;

  const mailer = getTransporter();
  if (!mailer) {
    console.log(`[EMAIL→${emailTo}] ${subject}: ${body}`);
    return;
  }

  await mailer.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@onfleet.africa',
    to: emailTo,
    subject,
    text: body,
    html: toHtml(body)
  });
}

async function sendSMS(to, body) {
  console.log(`[SMS→${to}] ${body}`);
}

async function sendWhatsApp(to, body) {
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
    throw e;
  }
  return info.lastInsertRowid;
}

module.exports = { sendEmail, sendNotification };
