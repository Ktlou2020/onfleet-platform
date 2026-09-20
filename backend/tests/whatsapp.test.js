import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgUser, createPgBike } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const axios = require('axios');
const { detectWhatsAppProvider, sendSms } = require('../src/services/smsProvider.js');
const { templateFor, templateVariables, TEMPLATES } = require('../src/constants/whatsappTemplates.js');
const { checkUnacknowledgedCriticalAlerts } = require('../src/services/alertEscalationService.js');

const ENV_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'TWILIO_SMS_FROM',
  'WHATSAPP_TEMPLATE_ALERT_ESCALATION'];

function withTwilio(extra = {}) {
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'secret', TWILIO_WHATSAPP_FROM: '+27110000000', ...extra,
  });
}

describe('sending on WhatsApp', () => {
  let saved;
  let post;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { sid: 'SMtest' } });
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    post.mockRestore();
  });

  it('is off until a WhatsApp sender is configured, even with SMS working', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    process.env.TWILIO_SMS_FROM = '+27110000001';
    expect(detectWhatsAppProvider()).toEqual({ name: 'none', configured: false });
    const outcome = await sendSms('0821234567', 'hello', { whatsapp: true });
    expect(outcome).toMatchObject({ delivered: false, reason: 'no_provider' });
    expect(post).not.toHaveBeenCalled();
  });

  it('sends free text when no template is approved yet (sandbox, or an open chat)', async () => {
    withTwilio();
    const outcome = await sendSms('0821234567', 'Tamper on LW78MDGP', { whatsapp: true });
    expect(outcome.delivered).toBe(true);
    const body = post.mock.calls[0][1];
    expect(body.get('To')).toBe('whatsapp:+27821234567');
    expect(body.get('From')).toBe('whatsapp:+27110000000');
    expect(body.get('Body')).toBe('Tamper on LW78MDGP');
    expect(body.get('ContentSid')).toBeNull();
  });

  it('sends the approved template, with its variables, once one is configured', async () => {
    withTwilio({ WHATSAPP_TEMPLATE_ALERT_ESCALATION: 'HX123' });
    const template = templateFor('alert_escalation');
    expect(template.sid).toBe('HX123');
    await sendSms('0821234567', 'fallback text', {
      whatsapp: true,
      contentSid: template.sid,
      variables: templateVariables('alert_escalation', { round: '1/4', alert: 'Tamper', bike: 'LW78MDGP', minutes: '6' }),
    });
    const body = post.mock.calls[0][1];
    expect(body.get('ContentSid')).toBe('HX123');
    expect(JSON.parse(body.get('ContentVariables'))).toEqual({ 1: '1/4', 2: 'Tamper', 3: 'LW78MDGP', 4: '6' });
    // Body and template are mutually exclusive — Twilio rejects both together
    expect(body.get('Body')).toBeNull();
  });

  it('numbers the variables in the order the template declares them', () => {
    const vars = templateVariables('payment_reminder', {
      first_name: 'Thandi', amount: '850.00', agreement_no: 'OF-2026-1', due_date: '2026-09-21',
    });
    expect(vars).toEqual({ 1: 'Thandi', 2: '850.00', 3: 'OF-2026-1', 4: '2026-09-21' });
  });

  it('keeps every template\'s wording and variable count in step', () => {
    for (const [name, t] of Object.entries(TEMPLATES)) {
      const slots = [...t.text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      expect(slots, `${name} placeholders`).toEqual(t.variables.map((_, i) => i + 1));
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)('escalating on WhatsApp', () => {
  let saved;
  let post;

  beforeEach(async () => {
    await resetAllPgTables();
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { sid: 'SMtest' } });
    await createPgUser({ role: 'superadmin', email: 'boss@example.test' });
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    post.mockRestore();
  });

  const raiseAlert = async (bikeId) => {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_alerts (bike_id, alert_type, severity, payload, created_at)
       VALUES ($1,'tamper','critical','{}', NOW() - INTERVAL '6 minutes') RETURNING *`, [bikeId]);
    return rows[0];
  };
  const attempts = async (alertId) =>
    (await pgDb.query('SELECT channel, status FROM alert_escalations WHERE alert_id=$1 ORDER BY id', [alertId])).rows;

  it('tries WhatsApp first and does not also send an SMS when it works', async () => {
    withTwilio({ TWILIO_SMS_FROM: '+27110000001' });
    const bike = await createPgBike({ registration: 'LW78MDGP' });
    const alert = await raiseAlert(bike.id);
    await checkUnacknowledgedCriticalAlerts();
    const tries = await attempts(alert.id);
    expect(tries.filter((t) => t.channel === 'whatsapp').every((t) => t.status === 'sent')).toBe(true);
    expect(tries.filter((t) => t.channel === 'sms')).toHaveLength(0);
  });

  it('falls back to SMS for that number when WhatsApp cannot carry it', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'secret';
    process.env.TWILIO_SMS_FROM = '+27110000001'; // SMS only, no WhatsApp sender
    const bike = await createPgBike({ registration: 'LW78MDGP' });
    const alert = await raiseAlert(bike.id);
    await checkUnacknowledgedCriticalAlerts();
    const tries = await attempts(alert.id);
    expect(tries.filter((t) => t.channel === 'whatsapp').every((t) => t.status === 'skipped')).toBe(true);
    expect(tries.filter((t) => t.channel === 'sms' && t.status === 'sent').length).toBeGreaterThan(0);
  });
});
