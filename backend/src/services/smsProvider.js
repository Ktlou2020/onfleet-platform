'use strict';

// Sending an SMS. Until now sendSMS was a stub that logged and reported
// 'no_provider', which is why 1,266 SMS rows sat at status 'skipped': a
// critical tracking alert could only ever reach an inbox. A theft alert has to
// reach a phone, so this speaks to a real provider when one is configured and
// still says plainly when one is not.
//
// Providers are chosen by whichever credentials are present, so adding the
// environment variables is the whole setup. No credential is ever logged.

const axios = require('axios');

const read = (name) => String(process.env[name] || '').trim().replace(/^"|"$/g, '');

// South African numbers arrive as 0821234567, 27821234567 or +27 82 123 4567.
// Providers want E.164, and a number that reaches nobody is worse than an
// error, so anything that can't be understood is rejected rather than guessed.
function toE164(raw, defaultCountry = '27') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  const plain = digits.replace(/\D/g, '');
  if (plain.startsWith('0')) return `+${defaultCountry}${plain.slice(1)}`;
  if (plain.startsWith(defaultCountry) && plain.length >= 10) return `+${plain}`;
  if (plain.length >= 8 && plain.length <= 15) return `+${defaultCountry}${plain}`;
  return null;
}

function detectSmsProvider() {
  const forced = read('SMS_PROVIDER').toLowerCase();
  const twilio = !!(read('TWILIO_ACCOUNT_SID') && read('TWILIO_AUTH_TOKEN') && read('TWILIO_SMS_FROM'));
  const brevo = !!(read('BREVO_API_KEY') && read('BREVO_SMS_SENDER'));
  const clickatell = !!read('CLICKATELL_API_KEY');
  const pick = forced || (twilio ? 'twilio' : brevo ? 'brevo' : clickatell ? 'clickatell' : 'none');
  const configured = pick === 'twilio' ? twilio : pick === 'brevo' ? brevo : pick === 'clickatell' ? clickatell : false;
  return { name: pick, configured };
}

async function sendWithTwilio(to, body, { whatsapp = false, contentSid = null, variables = null } = {}) {
  const sid = read('TWILIO_ACCOUNT_SID');
  const from = whatsapp ? read('TWILIO_WHATSAPP_FROM') : read('TWILIO_SMS_FROM');
  if (!from) return { delivered: false, reason: 'no_provider' };
  const params = new URLSearchParams({
    To: whatsapp ? `whatsapp:${to}` : to,
    From: whatsapp && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from,
  });
  // WhatsApp only lets a business start a conversation with a template Meta has
  // approved, so a template id wins over free text. Free text still works
  // inside the 24-hour window after someone messages us, and on the sandbox.
  if (contentSid) {
    params.set('ContentSid', contentSid);
    if (variables && Object.keys(variables).length) params.set('ContentVariables', JSON.stringify(variables));
  } else {
    params.set('Body', body);
  }
  const res = await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, params, {
    auth: { username: sid, password: read('TWILIO_AUTH_TOKEN') },
    timeout: 15000,
  });
  return { delivered: true, provider: 'twilio', id: res.data?.sid || null };
}

async function sendWithBrevo(to, body) {
  const res = await axios.post('https://api.brevo.com/v3/transactionalSMS/sms', {
    sender: read('BREVO_SMS_SENDER'), recipient: to.replace('+', ''), content: body, type: 'transactional',
  }, { headers: { 'api-key': read('BREVO_API_KEY'), 'content-type': 'application/json' }, timeout: 15000 });
  return { delivered: true, provider: 'brevo', id: res.data?.messageId || null };
}

async function sendWithClickatell(to, body) {
  const res = await axios.post('https://platform.clickatell.com/v1/message', {
    messages: [{ channel: 'sms', to: to.replace('+', ''), content: body }],
  }, { headers: { Authorization: read('CLICKATELL_API_KEY'), 'content-type': 'application/json' }, timeout: 15000 });
  return { delivered: true, provider: 'clickatell', id: res.data?.messages?.[0]?.apiMessageId || null };
}

// WhatsApp is configured separately from SMS: the same Twilio account can carry
// one and not the other, and a missing WhatsApp sender should not look like a
// missing SMS provider.
function detectWhatsAppProvider() {
  const twilio = !!(read('TWILIO_ACCOUNT_SID') && read('TWILIO_AUTH_TOKEN') && read('TWILIO_WHATSAPP_FROM'));
  return { name: twilio ? 'twilio' : 'none', configured: twilio };
}

async function sendSms(to, body, { whatsapp = false, contentSid = null, variables = null } = {}) {
  const number = toE164(to);
  if (!number) return { delivered: false, reason: 'bad_number' };
  const provider = whatsapp ? detectWhatsAppProvider() : detectSmsProvider();
  if (!provider.configured) {
    console.log(`[${whatsapp ? 'WhatsApp' : 'SMS'}→${number}] ${body}`);
    return { delivered: false, reason: 'no_provider' };
  }
  try {
    if (provider.name === 'twilio') return await sendWithTwilio(number, body, { whatsapp, contentSid, variables });
    if (whatsapp) return { delivered: false, reason: 'no_provider' }; // only Twilio carries WhatsApp today
    if (provider.name === 'brevo') return await sendWithBrevo(number, body);
    if (provider.name === 'clickatell') return await sendWithClickatell(number, body);
    return { delivered: false, reason: 'no_provider' };
  } catch (error) {
    const detail = error.response?.data?.message || error.response?.status || error.message;
    console.error(`[${whatsapp ? 'WhatsApp' : 'SMS'}→${number}] failed:`, detail);
    return { delivered: false, reason: 'send_failed', error: String(detail) };
  }
}

module.exports = { sendSms, detectSmsProvider, detectWhatsAppProvider, toE164 };
