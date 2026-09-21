import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();
const load = createRequire(import.meta.url);
const nightCurfew = load('../src/services/nightCurfew.js');

// Turning the curfew off, and letting one bike out at night, are the two
// controls that matter when this goes wrong at 01:00 — so they are reachable,
// they take effect immediately, and they are not open to everybody.
describe.skipIf(!process.env.DATABASE_URL)('the night curfew controls', () => {
  let admin;
  let controlRoom;
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    nightCurfew.clearAll();
    nightCurfew.reloadSettings();
    admin = (await createPgUser({ role: 'admin' })).user;
    controlRoom = (await createPgUser({ role: 'control_room' })).user;
    bike = await createPgBike({ registration: 'LW78MDGP' });
  });

  it('reports the curfew as on, and says what it does', async () => {
    const res = await request(app).get('/api/tracking/night-curfew').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.cut_below_kmh).toBe(10);
    expect(res.body.exempt_bikes).toEqual([]);
  });

  it('switches the whole curfew off, and it takes effect at once', async () => {
    const res = await request(app).put('/api/tracking/night-curfew').set(authHeader(admin)).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(await nightCurfew.isEnabled()).toBe(false);

    const { body } = await request(app).get('/api/tracking/night-curfew').set(authHeader(admin));
    expect(body.enabled).toBe(false);
  });

  it('exempts one bike, and lists it', async () => {
    const res = await request(app).put(`/api/tracking/night-curfew/bike/${bike.id}`)
      .set(authHeader(admin)).send({ exempt: true, reason: 'Night shift rider' });
    expect(res.status).toBe(200);
    expect(await nightCurfew.covers(bike.id)).toBe(false);

    const { body } = await request(app).get('/api/tracking/night-curfew').set(authHeader(admin));
    expect(body.exempt_bikes).toHaveLength(1);
    expect(body.exempt_bikes[0].registration).toBe('LW78MDGP');
  });

  it('puts a bike back under the curfew', async () => {
    await request(app).put(`/api/tracking/night-curfew/bike/${bike.id}`).set(authHeader(admin)).send({ exempt: true });
    await request(app).put(`/api/tracking/night-curfew/bike/${bike.id}`).set(authHeader(admin)).send({ exempt: false });
    expect(await nightCurfew.covers(bike.id)).toBe(true);
  });

  // Anything that immobilises vehicles by itself should say who changed it.
  it('records who switched it off', async () => {
    await request(app).put('/api/tracking/night-curfew').set(authHeader(admin)).send({ enabled: false });
    const { rows } = await pgDb.query(
      `SELECT actor_id, action FROM audit_logs WHERE action = 'tracking.night_curfew_off'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(admin.id);
  });

  it('records who let a bike out at night, and why', async () => {
    await request(app).put(`/api/tracking/night-curfew/bike/${bike.id}`)
      .set(authHeader(admin)).send({ exempt: true, reason: 'Night shift rider' });
    const { rows } = await pgDb.query(
      `SELECT actor_id, metadata FROM audit_logs WHERE action = 'tracking.night_curfew_exempt'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(admin.id);
    expect(JSON.stringify(rows[0].metadata)).toContain('Night shift rider');
  });

  describe('who may change it', () => {
    it('lets the control room see it', async () => {
      expect((await request(app).get('/api/tracking/night-curfew').set(authHeader(controlRoom))).status).toBe(200);
    });

    it('does not let the control room switch it off', async () => {
      const res = await request(app).put('/api/tracking/night-curfew').set(authHeader(controlRoom)).send({ enabled: false });
      expect(res.status).toBe(403);
      expect(await nightCurfew.isEnabled()).toBe(true);
    });

    it('does not let the control room exempt a bike', async () => {
      const res = await request(app).put(`/api/tracking/night-curfew/bike/${bike.id}`)
        .set(authHeader(controlRoom)).send({ exempt: true });
      expect(res.status).toBe(403);
    });

    it('is not open to a rider at all', async () => {
      const rider = (await createPgUser({ role: 'rider' })).user;
      expect((await request(app).get('/api/tracking/night-curfew').set(authHeader(rider))).status).toBe(403);
    });
  });

  it('refuses a bike that does not exist', async () => {
    const res = await request(app).put('/api/tracking/night-curfew/bike/999999')
      .set(authHeader(admin)).send({ exempt: true });
    expect(res.status).toBe(404);
  });
});
