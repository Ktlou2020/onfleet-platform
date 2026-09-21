import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAlert, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// An outsourced control room watching for theft does not need 1,071 idling
// alerts a month, and that noise is what makes a tamper alert easy to miss.
// Hiding a type narrows their list only: the alert is still raised, still
// escalates, and admins still see it.
describe.skipIf(!process.env.DATABASE_URL)('what the control room is shown', () => {
  let admin;
  let controlRoom;
  let bike;

  const hide = (type) => pgDb.query(
    `INSERT INTO alert_settings (alert_type, enabled, notify_enabled, control_room_visible)
     VALUES ($1, TRUE, TRUE, FALSE)
     ON CONFLICT (alert_type) DO UPDATE SET control_room_visible = FALSE`, [type]);
  const alertsFor = async (user) =>
    (await request(app).get('/api/tracking/alerts').set(authHeader(user))).body.map((a) => a.alert_type).sort();

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    controlRoom = (await createPgUser({ role: 'control_room', full_name: 'Night Desk' })).user;
    bike = await createPgBike({ registration: 'LW78MDGP' });
    for (const type of ['tamper', 'idle', 'low_battery']) {
      await createPgAlert({ bike_id: bike.id, alert_type: type });
    }
  });

  it('shows the control room everything until an admin says otherwise', async () => {
    expect(await alertsFor(controlRoom)).toEqual(['idle', 'low_battery', 'tamper']);
  });

  it('leaves a hidden type out of their list, but not out of an admin\'s', async () => {
    await hide('idle');
    expect(await alertsFor(controlRoom)).toEqual(['low_battery', 'tamper']);
    expect(await alertsFor(admin)).toEqual(['idle', 'low_battery', 'tamper']);
  });

  it('hides several types at once', async () => {
    await hide('idle');
    await hide('low_battery');
    expect(await alertsFor(controlRoom)).toEqual(['tamper']);
  });

  // Hiding an alert must not quietly stop it being raised or chased.
  it('still raises the alert, and still escalates it', async () => {
    await hide('tamper');
    const { rows: before } = await pgDb.query(`SELECT COUNT(*)::int AS n FROM tracking_alerts WHERE alert_type = 'tamper'`);
    expect(before[0].n).toBe(1);

    await pgDb.query(
      `INSERT INTO tracking_alerts (bike_id, alert_type, severity, payload, created_at)
       VALUES ($1,'tamper','critical','{}', NOW() - INTERVAL '10 minutes')`, [bike.id]);
    const { checkUnacknowledgedCriticalAlerts } = await import('../src/services/alertEscalationService.js');
    expect(await checkUnacknowledgedCriticalAlerts()).toBeGreaterThan(0);
  });

  it('does not let "acknowledge all" reach what they cannot see', async () => {
    await hide('idle');
    await request(app).post('/api/tracking/alerts/acknowledge-all').set(authHeader(controlRoom)).send({});
    const { rows } = await pgDb.query('SELECT alert_type, acknowledged_at FROM tracking_alerts ORDER BY alert_type');
    const idle = rows.find((r) => r.alert_type === 'idle');
    const tamper = rows.find((r) => r.alert_type === 'tamper');
    expect(idle.acknowledged_at).toBeNull();
    expect(tamper.acknowledged_at).toBeTruthy();
  });

  it('an admin acknowledging everything still reaches every alert', async () => {
    await hide('idle');
    await request(app).post('/api/tracking/alerts/acknowledge-all').set(authHeader(admin)).send({});
    const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM tracking_alerts WHERE acknowledged_at IS NULL');
    expect(rows[0].n).toBe(0);
  });

  describe('the setting itself', () => {
    it('is on for every type to begin with, and comes back on the settings', async () => {
      const res = await request(app).get('/api/tracking/alert-settings').set(authHeader(admin));
      expect(res.status).toBe(200);
      expect(res.body.every((s) => s.control_room_visible === true)).toBe(true);
    });

    it('saves what an admin chooses', async () => {
      const { body: settings } = await request(app).get('/api/tracking/alert-settings').set(authHeader(admin));
      const changed = settings.map((s) => (s.alert_type === 'idle' ? { ...s, control_room_visible: false } : s));
      expect((await request(app).put('/api/tracking/alert-settings').set(authHeader(admin)).send({ settings: changed })).status).toBe(200);

      const { body: after } = await request(app).get('/api/tracking/alert-settings').set(authHeader(admin));
      expect(after.find((s) => s.alert_type === 'idle').control_room_visible).toBe(false);
      expect(after.find((s) => s.alert_type === 'tamper').control_room_visible).toBe(true);
      expect(await alertsFor(controlRoom)).toEqual(['low_battery', 'tamper']);
    });

    it('is not something the control room can change for itself', async () => {
      const res = await request(app).put('/api/tracking/alert-settings').set(authHeader(controlRoom))
        .send({ settings: [{ alert_type: 'idle', enabled: true, notify_enabled: true, control_room_visible: true }] });
      expect(res.status).toBe(403);
    });
  });
});
