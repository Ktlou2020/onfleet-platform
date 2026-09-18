import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement } from './helpers/testPgDb.js';

const { buildEventBody } = createRequire(import.meta.url)('../src/services/webhookDispatcher.js');
const app = buildApp();

const WEEKDAY_11AM = '2026-09-16T09:00:00Z';  // Wednesday 11:00 in Johannesburg
const SATURDAY_NOON = '2026-09-19T10:00:00Z'; // Saturday 12:00 in Johannesburg
const RIDER_PHONE = '+27820000009';

// Alerts sent to a control room carry OnFleet's number for the time the alert
// happened, in the place receivers already read it, and no longer the rider's.
describe.skipIf(!process.env.DATABASE_URL)('the phone number sent with an alert', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    const rider = (await createPgUser({ role: 'rider', phone: RIDER_PHONE })).user;
    bike = await createPgBike();
    await createPgAgreement({ user_id: rider.id, bike_id: bike.id, status: 'active' });
  });

  it('is the office line for an alert raised during office hours', async () => {
    const body = await buildEventBody({ id: 1, alert_type: 'tamper', bike_id: bike.id, created_at: WEEKDAY_11AM, payload: {} });
    expect(body.contact).toEqual({ phone: '0101411165', hours: 'office' });
    expect(body.driver.phone).toBe('0101411165');
  });

  it('is the after-hours line for an alert raised at the weekend', async () => {
    const body = await buildEventBody({ id: 2, alert_type: 'tamper', bike_id: bike.id, created_at: SATURDAY_NOON, payload: {} });
    expect(body.contact).toEqual({ phone: '0815395612', hours: 'after_hours' });
    expect(body.driver.phone).toBe('0815395612');
  });

  it('no longer sends the rider\'s own number anywhere in the payload', async () => {
    const body = await buildEventBody({ id: 3, alert_type: 'tamper', bike_id: bike.id, created_at: WEEKDAY_11AM, payload: {} });
    expect(JSON.stringify(body)).not.toContain(RIDER_PHONE);
  });

  it('still carries the number when the bike has no rider', async () => {
    const spare = await createPgBike();
    const body = await buildEventBody({ id: 4, alert_type: 'device_offline', bike_id: spare.id, created_at: SATURDAY_NOON, payload: {} });
    expect(body.driver).toBeNull();
    expect(body.contact.phone).toBe('0815395612');
  });

  it('follows the same rule when alerts are pulled through the API', async () => {
    const admin = (await createPgUser({ role: 'superadmin' })).user;
    const rawKey = `onfleet_plat_${crypto.randomBytes(16).toString('hex')}`;
    await pgDb.query(
      `INSERT INTO api_keys (organization_id, created_by, name, key_hash, key_prefix, scope)
       VALUES (NULL, $1, 'Control Room', $2, $3, 'platform')`,
      [admin.id, crypto.createHash('sha256').update(rawKey).digest('hex'), rawKey.slice(0, 21)]);
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_alerts (alert_type, bike_id, payload, created_at)
       VALUES ('tamper', $1, '{}', $2), ('tamper', $1, '{}', $3) RETURNING id, created_at`,
      [bike.id, WEEKDAY_11AM, SATURDAY_NOON]);

    const res = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${rawKey}`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.alerts.map((a) => [a.id, a]));
    expect(byId[rows[0].id].contact.phone).toBe('0101411165');
    expect(byId[rows[0].id].driver.phone).toBe('0101411165');
    expect(byId[rows[1].id].contact.phone).toBe('0815395612');
    expect(JSON.stringify(res.body)).not.toContain(RIDER_PHONE);
  });
});
