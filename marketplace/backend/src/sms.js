'use strict';

// Text messages, for things that must reach a person even when no app is
// open — today, a store that hasn't answered a new order. Off until an SMS
// provider is configured:
//   BULKSMS_TOKEN_ID / BULKSMS_TOKEN_SECRET  (bulksms.com, popular in SA)
// Without them, send() does nothing and returns false.

function toInternational(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+27\d{9}$/.test(d)) return d;
  if (/^27\d{9}$/.test(d)) return `+${d}`;
  if (/^0\d{9}$/.test(d)) return `+27${d.slice(1)}`;
  return null;
}

function configured() {
  return !!(process.env.BULKSMS_TOKEN_ID && process.env.BULKSMS_TOKEN_SECRET);
}

async function send(phone, text, fetchImpl = fetch) {
  const to = toInternational(phone);
  if (!to || !configured()) return false;
  const auth = Buffer.from(`${process.env.BULKSMS_TOKEN_ID}:${process.env.BULKSMS_TOKEN_SECRET}`).toString('base64');
  const res = await fetchImpl('https://api.bulksms.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body: String(text).slice(0, 300) }),
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

module.exports = { send, configured, toInternational };
