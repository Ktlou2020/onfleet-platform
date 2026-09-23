import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// A technician fitting a tracker needs to know whether it works. Technicians
// are otherwise barred from every tracking route, so this is a hole in that
// wall and the tests are mostly about its edges: it must answer for the bike
// in front of them and refuse to be walked anywhere else.
describe.skipIf(!process.env.DATABASE_URL)('checking a tracker from a job card', () => {
  let tech;
  let admin;
  let rider;
  let bike;
  let otherBike;
  let card;

  const check = (id, as) =>
    request(app).get(`/api/workshop/job-cards/${id}/tracker-check`).set(authHeader(as));

  const addDevice = async (bikeId, over = {}) => {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, connected, last_seen_at, ignition_trusted_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [over.imei || `imei-${bikeId}-${Date.now()}`, bikeId, over.connected ?? true,
       over.last_seen_at === undefined ? new Date() : over.last_seen_at,
       over.ignition_trusted_at || null]);
    return rows[0].id;
  };

  const makeCard = async (bikeId, status = 'open') => {
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, registration, job_type, description, status, technician_id, created_by)
       VALUES ($1,$2,'service','Fit tracker',$3,$4,$4) RETURNING id`,
      [bikeId, 'WS-01GP', status, tech.id]);
    return rows[0].id;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'superadmin' })).user;
    tech = (await createPgUser({ role: 'technician' })).user;
    rider = (await createPgUser({ role: 'rider' })).user;
    bike = await createPgBike({ registration: 'WS-01GP' });
    otherBike = await createPgBike({ registration: 'ZZ-99GP' });
    card = await makeCard(bike.id);
  });

  it('answers a technician for the bike their job card is on', async () => {
    await addDevice(bike.id);
    const res = await check(card, tech);
    expect(res.status).toBe(200);
    expect(res.body.has_device).toBe(true);
    expect(res.body.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(['connected', 'reporting', 'gps_fix', 'power', 'ignition']));
  });

  // The whole point of routing this through a job card.
  it('gives a technician no way to ask about another bike', async () => {
    await addDevice(otherBike.id, { imei: 'other-bike' });
    const { rows } = await pgDb.query('SELECT id FROM tracking_devices WHERE imei = $1', ['other-bike']);

    // The tracking routes stay shut to them...
    expect((await request(app).get(`/api/tracking/devices/${rows[0].id}/install-check`).set(authHeader(tech))).status).toBe(403);
    expect((await request(app).get('/api/tracking/devices').set(authHeader(tech))).status).toBe(403);
    // ...and there is no job card of theirs that reaches that bike.
    expect((await check(99999, tech)).status).toBe(404);
  });

  it('refuses anyone outside the workshop', async () => {
    await addDevice(bike.id);
    expect((await check(card, rider)).status).toBe(403);
    expect((await request(app).get(`/api/workshop/job-cards/${card}/tracker-check`)).status).toBe(401);
  });

  // A finished job is no longer a reason to be looking at a bike's tracker.
  it('stops answering once the job is closed', async () => {
    await addDevice(bike.id);
    for (const status of ['completed', 'cancelled']) {
      await pgDb.query('UPDATE job_cards SET status = $1 WHERE id = $2', [status, card]);
      const res = await check(card, tech);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/closed/i);
    }
  });

  it('says plainly when no tracker is registered rather than failing', async () => {
    const res = await check(card, tech);
    expect(res.status).toBe(200);
    expect(res.body.has_device).toBe(false);
    expect(res.body.message).toMatch(/WS-01GP/);
  });

  it('explains a job card that is not linked to a bike', async () => {
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (vin, registration, make, model, job_type, description, status, created_by)
       VALUES ('LOOSEVIN','NEW-1','Honda','ACE 125','repair','Walk-in','open',$1) RETURNING id`, [tech.id]);
    const res = await check(rows[0].id, tech);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not linked to a bike/i);
  });

  // It reports the tracker, not the fleet. The sign-off is an admin's record
  // of a decision and has no business in a technician's hands.
  it('returns the checks without the commissioning sign-off', async () => {
    const deviceId = await addDevice(bike.id);
    await pgDb.query(
      `INSERT INTO device_commissioning (device_id, commissioned_at, commissioned_by, checks, notes, updated_at)
       VALUES ($1, NOW(), $2, '[]', 'signed off by the boss', NOW())`, [deviceId, admin.id]);

    const res = await check(card, tech);
    expect(res.body.commissioning).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('signed off by the boss');
    expect(Object.keys(res.body.device).sort()).toEqual(['imei', 'last_seen_at', 'model', 'registration']);
  });

  it('lets an admin use the same route', async () => {
    await addDevice(bike.id);
    expect((await check(card, admin)).status).toBe(200);
  });

  // The check that was written for the ignition wire: element 239 reports a
  // well-formed 0 for ever when the line is not connected, so it passes only
  // once the tracker has been seen reporting ignition ON.
  it('fails the ignition check until the tracker has proved the wire', async () => {
    await addDevice(bike.id);
    const before = (await check(card, tech)).body.checks.find((c) => c.id === 'ignition');
    expect(before.passed).toBe(false);

    await pgDb.query('UPDATE tracking_devices SET ignition_trusted_at = NOW() WHERE bike_id = $1', [bike.id]);
    const after = (await check(card, tech)).body.checks.find((c) => c.id === 'ignition');
    expect(after.passed).toBe(true);
  });
});
