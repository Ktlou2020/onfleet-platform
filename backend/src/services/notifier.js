const axios = require('axios');
const nodemailer = require('nodemailer');
const db = require('../db');

let transporter;

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseIdentity(rawValue, fallbackEmail = 'no-reply@onfleet.africa', fallbackName = 'OnFleet Africa') {
  const raw = String(rawValue || '').trim();
  const match = raw.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return {
      name: String(match[1] || '').trim().replace(/^"|"$/g, '') || fallbackName,
      email: String(match[2] || '').trim() || fallbackEmail
    };
  }
  if (raw.includes('@')) {
    return { name: fallbackName, email: raw };
  }
  return { name: raw || fallbackName, email: fallbackEmail };
}

function getSenderIdentity() {
  const fallbackEmail = readEnv('BREVO_SENDER_EMAIL', readEnv('SMTP_USER', 'no-reply@onfleet.africa')) || 'no-reply@onfleet.africa';
  const base = parseIdentity(readEnv('EMAIL_FROM', ''), fallbackEmail, readEnv('EMAIL_FROM_NAME', 'OnFleet Africa'));
  return {
    name: readEnv('EMAIL_FROM_NAME', base.name || 'OnFleet Africa').trim(),
    email: readEnv('BREVO_SENDER_EMAIL', base.email || fallbackEmail).trim()
  };
}

function getReplyToIdentity() {
  const raw = readEnv('EMAIL_REPLY_TO', '');
  if (!raw) return null;
  return parseIdentity(raw, getSenderIdentity().email, getSenderIdentity().name);
}

function detectEmailProvider() {
  const preferred = readEnv('EMAIL_PROVIDER', '').toLowerCase();
  const sender = getSenderIdentity();
  const hasBrevo = !!readEnv('BREVO_API_KEY', '');
  const hasSmtp = !!readEnv('SMTP_HOST', '');

  if ((preferred === 'brevo' && hasBrevo) || (!preferred && hasBrevo)) {
    return {
      name: 'brevo',
      configured: true,
      channel: 'api',
      fromName: sender.name,
      fromEmail: sender.email
    };
  }

  if ((preferred === 'smtp' && hasSmtp) || (!preferred && hasSmtp)) {
    return {
      name: 'smtp',
      configured: true,
      channel: 'smtp',
      fromName: sender.name,
      fromEmail: sender.email
    };
  }

  return {
    name: preferred || 'log',
    configured: false,
    channel: 'console',
    fromName: sender.name,
    fromEmail: sender.email
  };
}

function getTransporter() {
  if (transporter !== undefined) return transporter;

  const host = readEnv('SMTP_HOST', '');
  const port = Number(readEnv('SMTP_PORT', '587') || 587);
  const user = readEnv('SMTP_USER', '');
  const pass = readEnv('SMTP_PASS', '');

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

async function sendWithBrevo(to, subject, body) {
  const apiKey = readEnv('BREVO_API_KEY', '');
  if (!apiKey) throw new Error('BREVO_API_KEY is not configured');

  const sender = getSenderIdentity();
  const replyTo = getReplyToIdentity();
  const payload = {
    sender,
    to: [{ email: to }],
    subject,
    textContent: body,
    htmlContent: toHtml(body)
  };
  if (replyTo?.email) payload.replyTo = replyTo;

  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      timeout: 30000
    });
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data?.message || error.response?.data?.code || error.message;
    throw new Error(status ? `Brevo API ${status}: ${detail}` : `Brevo API error: ${detail}`);
  }
}

async function sendWithSmtp(to, subject, body) {
  const mailer = getTransporter();
  if (!mailer) throw new Error('SMTP is not configured');
  const sender = getSenderIdentity();
  const replyTo = getReplyToIdentity();

  await mailer.sendMail({
    from: `${sender.name} <${sender.email}>`,
    to,
    replyTo: replyTo?.email ? `${replyTo.name} <${replyTo.email}>` : undefined,
    subject,
    text: body,
    html: toHtml(body)
  });
}

async function sendEmail(to, subject, body) {
  const emailTo = String(to || '').trim();
  if (!emailTo) return;

  const provider = detectEmailProvider();
  if (provider.name === 'brevo' && provider.configured) {
    await sendWithBrevo(emailTo, subject, body);
    return;
  }

  if (provider.name === 'smtp' && provider.configured) {
    await sendWithSmtp(emailTo, subject, body);
    return;
  }

  console.log(`[EMAIL→${emailTo}] ${subject}: ${body}`);
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
    console.error(`[notification:${channel}:${type}]`, e.message);
    db.prepare(`UPDATE notifications SET status = 'failed' WHERE id = ?`).run(info.lastInsertRowid);
    throw e;
  }
  return info.lastInsertRowid;
}

module.exports = { sendEmail, sendNotification, detectEmailProvider };
