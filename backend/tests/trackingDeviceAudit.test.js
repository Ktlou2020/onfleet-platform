import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Nobody could say who put tracker 353201352317926 on a paid-off bike: device
// registration and relinking left no record. These cover the audit trail.
describe.skipIf(!process.env.DATABASE_URL)('tracker audit trail', () => {
  let admin;
  let bikeA;
  let bikeB;
  const audits = async (action) =>
    (await pgDb.query('SELECT * FROM audit_logs WHERE action = $1 ORDER BY id', [action])).rows
      .map((r) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata }));
  const register = (body) =>
    request(app).post('/api/tracking/devices').set(authHeader(admin)).send({ model: 'FMB920', ...body });

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    bikeA = await createPgBike({ registration: 'LW78MDGP' });
    bikeB = await createPgBike({ registration: 'LW78LKGP' });
  });

  it('records who registered a tracker and which bike it went on', async () => {
    const res = await register({ imei: '353201352317926', bike_id: bikeA.id });
    expect(res.status).toBe(201);
    const [entry] = await audits('tracking.device_register');
    expect(entry.actor_id).toBe(admin.id);
    expect(entry.entity_id).toBe(res.body.id);
    expect(entry.metadata).toMatchObject({ imei: '353201352317926', bike_id: bikeA.id, registration: 'LW78MDGP' });
  });

  it('records a rejected attempt to register a tracker that is already on another bike', async () => {
    await register({ imei: '353201352317926', bike_id: bikeA.id });
    expect((await register({ imei: '353201352317926', bike_id: bikeB.id })).status).toBe(409);
    const [entry] = await audits('tracking.device_register_rejected');
    expect(entry.metadata).toMatchObject({
      imei: '353201352317926', attempted_registration: 'LW78LKGP', current_registration: 'LW78MDGP',
    });
  });

  it('records a relink with the bike it came from and the bike it went to', async () => {
    const { body } = await register({ imei: '353201352317926', bike_id: bikeA.id });
    await request(app).put(`/api/tracking/devices/${body.id}`).set(authHeader(admin)).send({ bike_id: bikeB.id });
    const [entry] = await audits('tracking.device_relink');
    expect(entry.metadata).toMatchObject({
      imei: '353201352317926', from_registration: 'LW78MDGP', to_registration: 'LW78LKGP',
    });
  });

  it('tells linking and unlinking apart from relinking', async () => {
    const { body } = await register({ imei: '352592576608251' });
    const put = (b) => request(app).put(`/api/tracking/devices/${body.id}`).set(authHeader(admin)).send(b);
    await put({ bike_id: bikeA.id });
    await put({ bike_id: null });
    expect((await audits('tracking.device_link'))[0].metadata).toMatchObject({ from_bike_id: null, to_registration: 'LW78MDGP' });
    expect((await audits('tracking.device_unlink'))[0].metadata).toMatchObject({ from_registration: 'LW78MDGP', to_bike_id: null });
    expect(await audits('tracking.device_relink')).toHaveLength(0);
  });

  it('records setting changes but not saves that change nothing', async () => {
    const { body } = await register({ imei: '352592576608251', bike_id: bikeA.id });
    const put = (b) => request(app).put(`/api/tracking/devices/${body.id}`).set(authHeader(admin)).send(b);
    await put({ speed_limit_kmh: 80 });
    await put({ bike_id: bikeA.id, model: 'FMB920' });
    const entries = await audits('tracking.device_update');
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata.changes.speed_limit_kmh.to).toBe(80);
    expect(await audits('tracking.device_relink')).toHaveLength(0);
  });

  it('records deletion with the IMEI and bike, since the device row is gone afterwards', async () => {
    const { body } = await register({ imei: '352592576608251', bike_id: bikeA.id });
    expect((await request(app).delete(`/api/tracking/devices/${body.id}`).set(authHeader(admin))).status).toBe(200);
    const [entry] = await audits('tracking.device_delete');
    expect(entry.metadata).toMatchObject({ imei: '352592576608251', registration: 'LW78MDGP' });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('tracker coverage', () => {
  it('counts only active bikes', async () => {
    await resetAllPgTables();
    const admin = (await createPgUser({ role: 'admin' })).user;
    const active = await createPgBike({ status: 'active' });
    await createPgBike({ status: 'active' });
    const paidOff = await createPgBike({ status: 'paid_off' });
    await createPgBike({ status: 'stolen' });
    await createPgBike({ status: 'repairs' });
    await pgDb.query(`INSERT INTO tracking_devices (imei, model, bike_id) VALUES ('111111111111111','FMB920',$1), ('222222222222222','FMB920',$2)`,
      [active.id, paidOff.id]);
    const res = await request(app).get('/api/tracking/dashboard').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.fleet_coverage).toEqual({ total_in_service: 2, with_device: 1 });
  });
});
