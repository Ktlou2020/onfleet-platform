import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgUser, createPgBike } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const { checkUnacknowledgedCriticalAlerts } = require('../src/services/alertEscalationService.js');
const { toE164 } = require('../src/services/smsProvider.js');

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

async function raise({ type = 'tamper', minutes = 6, payload = {}, bikeId }) {
  const { rows } = await pgDb.query(
    `INSERT INTO tracking_alerts (bike_id, alert_type, severity, payload, created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [bikeId, type, type === 'idle' ? 'low' : 'critical', JSON.stringify(payload), minutesAgo(minutes)]);
  return rows[0];
}

const attempts = async (alertId) =>
  (await pgDb.query('SELECT * FROM alert_escalations WHERE alert_id=$1 ORDER BY id', [alertId])).rows;
const roundOf = async (alertId) =>
  Number((await pgDb.query('SELECT escalation_round FROM tracking_alerts WHERE id=$1', [alertId])).rows[0].escalation_round);

// A tamper alert took six hours on average to be acknowledged, and escalation
// sent one email and gave up. It now chases until someone acknowledges.
describe.skipIf(!process.env.DATABASE_URL)('chasing unacknowledged critical alerts', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    await createPgUser({ role: 'superadmin', email: 'boss@example.test' });
    bike = await createPgBike({ registration: 'LW78MDGP' });
  });

  it('escalates after five minutes and records every attempt', async () => {
    const alert = await raise({ bikeId: bike.id, minutes: 6 });
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(1);
    expect(await roundOf(alert.id)).toBe(1);

    const tries = await attempts(alert.id);
    expect(tries.filter((t) => t.channel === 'email')).toHaveLength(1);
    const sms = tries.filter((t) => t.channel === 'sms');
    // The office line for a weekday morning, or the after-hours line otherwise:
    // either way a real number is attempted, and with no SMS provider wired up
    // the attempt is recorded as skipped rather than silently dropped.
    expect(sms.length).toBeGreaterThan(0);
    expect(sms.every((t) => /^\+27\d+$/.test(t.target))).toBe(true);
    expect(sms.every((t) => t.status === 'skipped')).toBe(true);
  });

  it('does not escalate before the first round is due', async () => {
    const alert = await raise({ bikeId: bike.id, minutes: 2 });
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(0);
    expect(await roundOf(alert.id)).toBe(0);
  });

  it('does not chase an alert somebody has acknowledged or closed', async () => {
    const ackd = await raise({ bikeId: bike.id, minutes: 30 });
    const closed = await raise({ bikeId: bike.id, minutes: 30 });
    await pgDb.query('UPDATE tracking_alerts SET acknowledged_at=NOW() WHERE id=$1', [ackd.id]);
    await pgDb.query('UPDATE tracking_alerts SET resolved_at=NOW() WHERE id=$1', [closed.id]);
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(0);
  });

  it('runs one round at a time, however often the sweep runs', async () => {
    const alert = await raise({ bikeId: bike.id, minutes: 20 });
    await checkUnacknowledgedCriticalAlerts();
    await checkUnacknowledgedCriticalAlerts();
    await checkUnacknowledgedCriticalAlerts();
    // 20 minutes in, rounds 1 (5 min) and 2 (15 min) are due; round 3 is not.
    expect(await roundOf(alert.id)).toBe(2);
    expect((await attempts(alert.id)).filter((t) => t.channel === 'email').map((t) => t.round)).toEqual([1, 2]);
  });

  it('stops after the last round', async () => {
    const alert = await raise({ bikeId: bike.id, minutes: 600 });
    for (let i = 0; i < 8; i += 1) await checkUnacknowledgedCriticalAlerts();
    expect(await roundOf(alert.id)).toBe(4);
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(0);
  });

  it('tells the control room again from the second round', async () => {
    await pgDb.query(
      `INSERT INTO webhook_endpoints (name, url, secret, scope, active)
       VALUES ('Control Room', 'https://127.0.0.1:9/hook', 'whsec_test', 'platform', TRUE)`);
    const alert = await raise({ bikeId: bike.id, minutes: 20 });
    await checkUnacknowledgedCriticalAlerts(); // round 1 — email and SMS only
    expect((await pgDb.query('SELECT event_id FROM webhook_deliveries')).rows).toHaveLength(0);
    await checkUnacknowledgedCriticalAlerts(); // round 2 — control room told again
    const { rows } = await pgDb.query('SELECT event_id, payload FROM webhook_deliveries');
    expect(rows.map((r) => r.event_id)).toEqual([`escalation-${alert.id}-2`]);
    expect(JSON.parse(rows[0].payload).escalation).toMatchObject({ round: 2, of: 4 });
  });

  it('leaves everyday alerts alone', async () => {
    await raise({ bikeId: bike.id, type: 'idle', minutes: 120 });
    await raise({ bikeId: bike.id, type: 'theft_risk', minutes: 120, payload: { level: 'medium' } });
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(0);
  });

  it('chases a critical theft-risk score', async () => {
    await raise({ bikeId: bike.id, type: 'theft_risk', minutes: 10, payload: { level: 'critical' } });
    expect(await checkUnacknowledgedCriticalAlerts()).toBe(1);
  });
});

describe('phone numbers for SMS', () => {
  it('turns South African numbers into the form a provider accepts', () => {
    expect(toE164('0101411165')).toBe('+27101411165');
    expect(toE164('082 123 4567')).toBe('+27821234567');
    expect(toE164('+27 82 123 4567')).toBe('+27821234567');
    expect(toE164('27821234567')).toBe('+27821234567');
  });

  it('refuses a number it cannot make sense of, rather than guessing', () => {
    expect(toE164('12345')).toBeNull();
    expect(toE164('not a phone')).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164(null)).toBeNull();
  });
});
