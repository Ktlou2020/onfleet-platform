import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const require = createRequire(import.meta.url);
const commissioning = require('../src/services/deviceCommissioning.js');
const app = buildApp();

const IO_GOOD = JSON.stringify({ 21: 4, 66: 12400, 67: 4000, 239: 1 });

async function addDevice({ imei = '353201352317926', bikeId = null, lastSeen = null } = {}) {
  const { rows } = await pgDb.query(
    `INSERT INTO tracking_devices (imei, model, bike_id, last_seen_at) VALUES ($1,'FMB920',$2,$3) RETURNING *`,
    [imei, bikeId, lastSeen]);
  return rows[0];
}
async function addPing(bikeId, { io = IO_GOOD, lat = -26.2, lng = 28.0, sats = 9, at = new Date() } = {}) {
  await pgDb.query(
    `INSERT INTO gps_pings (bike_id, lat, lng, satellites, io_data, recorded_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [bikeId, lat, lng, sats, io, at]);
}

// Five trackers registered on one morning had never sent a byte, and nothing
// said so. An install is only done when the tracker has proved it works.
describe.skipIf(!process.env.DATABASE_URL)('proving a tracker is installed', () => {
  let admin;
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    bike = await createPgBike({ registration: 'LJ89MWGP' });
  });

  it('passes every required check for a properly installed tracker', async () => {
    const device = await addDevice({ bikeId: bike.id, lastSeen: new Date() });
    await addPing(bike.id);
    const result = await commissioning.runChecks(device.id);
    expect(result.ready).toBe(true);
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.connected.passed).toBe(true);
    expect(byId.gps_fix.detail).toMatch(/9 satellites/);
    expect(byId.power.detail).toBe('12.4 V');
    expect(byId.ignition.passed).toBe(true);
  });

  it('fails the tracker that has never connected, and says what to check', async () => {
    const device = await addDevice({ imei: '352592576608251', bikeId: bike.id });
    const result = await commissioning.runChecks(device.id);
    expect(result.ready).toBe(false);
    const connected = result.checks.find((c) => c.id === 'connected');
    expect(connected.passed).toBe(false);
    expect(connected.detail).toMatch(/power, SIM data/i);
  });

  it('fails a tracker that is reporting but not wired to power', async () => {
    const device = await addDevice({ bikeId: bike.id, lastSeen: new Date() });
    await addPing(bike.id, { io: JSON.stringify({ 21: 3, 67: 3900 }) });
    const result = await commissioning.runChecks(device.id);
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.id === 'power')).toMatchObject({ passed: false, required: true });
    // A missing ignition line is worth knowing but doesn't block the install
    expect(result.checks.find((c) => c.id === 'ignition')).toMatchObject({ passed: false, required: false });
  });

  it('fails a tracker that has gone quiet since it was installed', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    const device = await addDevice({ bikeId: bike.id, lastSeen: twoDaysAgo });
    await addPing(bike.id, { at: twoDaysAgo });
    const result = await commissioning.runChecks(device.id);
    expect(result.checks.find((c) => c.id === 'connected').passed).toBe(true);
    expect(result.checks.find((c) => c.id === 'reporting').passed).toBe(false);
    expect(result.ready).toBe(false);
  });

  describe('signing off', () => {
    it('refuses to sign off an install that has not passed, unless a reason is given', async () => {
      const device = await addDevice({ imei: '352592576608251', bikeId: bike.id });
      const refused = await request(app).post(`/api/tracking/devices/${device.id}/commission`).set(authHeader(admin)).send({});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/Not ready yet/);
      expect((await pgDb.query('SELECT * FROM device_commissioning')).rows).toHaveLength(0);

      const forced = await request(app).post(`/api/tracking/devices/${device.id}/commission`).set(authHeader(admin))
        .send({ override_reason: 'Installed in a basement, will confirm tomorrow' });
      expect(forced.status).toBe(200);
      const { rows } = await pgDb.query('SELECT * FROM device_commissioning');
      expect(rows[0]).toMatchObject({ device_id: device.id, commissioned_by: admin.id });
      expect(rows[0].override_reason).toMatch(/basement/);
    });

    it('signs off a good install and keeps the evidence and the auditor', async () => {
      const device = await addDevice({ bikeId: bike.id, lastSeen: new Date() });
      await addPing(bike.id);
      const res = await request(app).post(`/api/tracking/devices/${device.id}/commission`).set(authHeader(admin)).send({ notes: 'Under the seat' });
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query('SELECT * FROM device_commissioning');
      expect(rows[0].checks.find((c) => c.id === 'gps_fix').passed).toBe(true);
      const { rows: audit } = await pgDb.query(`SELECT actor_id FROM audit_logs WHERE action='tracking.device_commissioned'`);
      expect(audit[0].actor_id).toBe(admin.id);
    });
  });

  describe('fleet health', () => {
    it('sorts trackers into reporting, quiet, silent and never connected', async () => {
      const bikes = [bike, await createPgBike(), await createPgBike()];
      await addDevice({ imei: '111111111111111', bikeId: bikes[0].id, lastSeen: new Date() });
      await addDevice({ imei: '222222222222222', bikeId: bikes[1].id, lastSeen: new Date(Date.now() - 3 * 3600 * 1000) });
      await addDevice({ imei: '333333333333333', bikeId: bikes[2].id, lastSeen: new Date(Date.now() - 72 * 3600 * 1000) });
      await addDevice({ imei: '444444444444444' });

      const { summary, devices } = await commissioning.fleetHealth();
      expect(summary).toMatchObject({ total: 4, reporting: 1, quiet: 1, silent: 1, never_connected: 1, unlinked: 1, uncommissioned: 4 });
      expect(summary.reporting_pct).toBe(25);
      expect(devices.find((d) => d.imei === '222222222222222').state).toBe('quiet');
    });

    it('counts an install as overdue once a day has passed with no sign-off', async () => {
      const old = await addDevice({ imei: '555555555555555', bikeId: bike.id });
      await pgDb.query("UPDATE tracking_devices SET created_at = NOW() - INTERVAL '3 days' WHERE id=$1", [old.id]);
      await addDevice({ imei: '666666666666666' }); // registered just now — not overdue yet
      const { summary } = await commissioning.fleetHealth();
      expect(summary.awaiting_install_proof).toBe(1);

      await commissioning.commission({ deviceId: old.id, actorId: admin.id, overrideReason: 'signed off late' });
      expect((await commissioning.fleetHealth()).summary.awaiting_install_proof).toBe(0);
    });
  });
});
