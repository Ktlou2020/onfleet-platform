'use strict';

/**
 * WhatsApp message templates.
 *
 * Meta only lets a business start a WhatsApp conversation with a template it
 * has approved in advance; free text is refused outside the 24-hour window
 * after the person messages you (and on Twilio's sandbox, where it works).
 * So every message OnFleet sends first has to be one of these, with the
 * variable slots filled in.
 *
 * Each entry records the exact wording submitted to Meta, so the text here and
 * the text approved there can be compared without leaving the codebase. The
 * approved template's id (Twilio calls it a Content SID, HX...) goes in the
 * environment variable named below; until it is set, the message falls back to
 * free text, which works on the sandbox and inside an open conversation.
 *
 * Variables are numbered because that is what Meta and Twilio use: {{1}},
 * {{2}}, and so on, in the order listed in `variables`.
 */

const TEMPLATES = {
  // Control room: a critical alert nobody has acknowledged. Staff-facing.
  alert_escalation: {
    env: 'WHATSAPP_TEMPLATE_ALERT_ESCALATION',
    category: 'UTILITY',
    text: 'OnFleet alert {{1}}: {{2}} on {{3}}. Unacknowledged for {{4}} minutes. Open the control room to acknowledge or close it.',
    variables: ['round', 'alert', 'bike', 'minutes'],
  },
  // Rider: the weekly instalment falls due tomorrow.
  payment_reminder: {
    env: 'WHATSAPP_TEMPLATE_PAYMENT_REMINDER',
    category: 'UTILITY',
    text: 'Hi {{1}}, your weekly OnFleet payment of R{{2}} for agreement {{3}} is due tomorrow ({{4}}). Pay via the app to keep your rent-to-own on track.',
    variables: ['first_name', 'amount', 'agreement_no', 'due_date'],
  },
  // Rider: the instalment was missed.
  payment_overdue: {
    env: 'WHATSAPP_TEMPLATE_PAYMENT_OVERDUE',
    category: 'UTILITY',
    text: 'Hi {{1}}, your OnFleet payment of R{{2}} for agreement {{3}} is overdue{{4}}. Please pay as soon as you can to keep your agreement in good standing.',
    variables: ['first_name', 'amount', 'agreement_no', 'weeks_note'],
  },
};

const read = (name) => String(process.env[name] || '').trim();

// The approved template id for a message type, or null when it hasn't been set
// up yet (in which case the caller falls back to free text).
function templateFor(type) {
  const template = TEMPLATES[type];
  if (!template) return null;
  const sid = read(template.env);
  if (!sid) return null;
  return { ...template, sid };
}

// Meta wants the variables as {"1": "...", "2": "..."} in the declared order.
function templateVariables(type, values = {}) {
  const template = TEMPLATES[type];
  if (!template) return null;
  const out = {};
  template.variables.forEach((name, i) => { out[String(i + 1)] = String(values[name] ?? ''); });
  return out;
}

module.exports = { TEMPLATES, templateFor, templateVariables };
