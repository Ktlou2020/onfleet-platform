import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// Fitting a tracker to somebody else's bike.
//
// On a telematics deployment the operator owns no motorcycles — every bike on
// the platform belongs to a customer — and fitting trackers to those bikes is
// the operator's entire job. The device form used to source its bike list
// from GET /api/bikes, whose visibility clause requires organization_id IS
// NULL because it answers a different question: which bikes does the platform
// itself own. The result was a dropdown with nothing in it.
//
// The other half is the boundary underneath: a fleet owner may watch their
// bikes on the map and send a command to a tracker already fitted to one, and
// may not register, re-link or delete a device. That is the operator's.

describe.skipIf(!process.env.DATABASE_URL)('allocating trackers to fleet bikes', () => {
  let superadmin, fleetOwner, orgA, orgB, bikeA, bikeB, platformBike;

  // createPgBike does not know about workshop_only, so a "walk-in" made with
  // it is an ordinary fleet bike and proves nothing.
  const walkInBike = async (registration) => {
    const bike = await createPgBike({ registration });
    await pgDb.query('UPDATE bikes SET workshop_only = TRUE WHERE id = $1', [bike.id]);
    return bike;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    orgA = await createPgOrg({ name: 'Rapid Wheels' });
    orgB = await createPgOrg({ name: 'Kasi Couriers' });
    fleetOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: orgA.id });

    bikeA = await createPgBike({ registration: 'RAP001GP', organization_id: orgA.id });
    bikeB = await createPgBike({ registration: 'KAS001GP', organization_id: orgB.id });
    platformBike = await createPgBike({ registration: 'PLT001GP' });
  });

  describe('what the operator can allocate to', () => {
    it('lists bikes belonging to fleet owners, which is the whole point', async () => {
      const res = await request(app).get('/api/tracking/allocatable-bikes')
        .set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
      const regs = res.body.bikes.map((b) => b.registration);
      expect(regs, 'a customer\'s bike was missing, so no tracker could be fitted to it')
        .toEqual(expect.arrayContaining(['RAP001GP', 'KAS001GP', 'PLT001GP']));
    });

    it('says which fleet each bike belongs to', async () => {
      const res = await request(app).get('/api/tracking/allocatable-bikes')
        .set(authHeader(superadmin.user));
      const rap = res.body.bikes.find((b) => b.registration === 'RAP001GP');
      const plt = res.body.bikes.find((b) => b.registration === 'PLT001GP');
      expect(rap.owner).toMatchObject({ type: 'fleet_owner', name: 'Rapid Wheels' });
      expect(plt.owner.type, 'platform stock was attributed to a fleet').toBe('platform');
    });

    it('leaves out a walk-in bike the workshop registered', async () => {
      await walkInBike('WALKIN1');
      const res = await request(app).get('/api/tracking/allocatable-bikes')
        .set(authHeader(superadmin.user));
      expect(res.body.bikes.map((b) => b.registration)).not.toContain('WALKIN1');
    });

    it('shows a bike that already has a tracker, and which one', async () => {
      await request(app).post('/api/tracking/devices').set(authHeader(superadmin.user))
        .send({ imei: '350000000000111', model: 'FMB920', bike_id: bikeA.id });

      const res = await request(app).get('/api/tracking/allocatable-bikes')
        .set(authHeader(superadmin.user));
      const rap = res.body.bikes.find((b) => b.registration === 'RAP001GP');
      expect(rap.tracker.imei).toBe('350000000000111');
    });

    it('can filter to bikes with no tracker yet', async () => {
      await request(app).post('/api/tracking/devices').set(authHeader(superadmin.user))
        .send({ imei: '350000000000111', bike_id: bikeA.id });

      const res = await request(app).get('/api/tracking/allocatable-bikes?unassigned_only=true')
        .set(authHeader(superadmin.user));
      expect(res.body.bikes.map((b) => b.registration)).not.toContain('RAP001GP');
      expect(res.body.bikes.map((b) => b.registration)).toContain('KAS001GP');
    });

    it('searches by fleet name, not only by registration', async () => {
      const res = await request(app).get('/api/tracking/allocatable-bikes?q=kasi')
        .set(authHeader(superadmin.user));
      expect(res.body.bikes.map((b) => b.registration)).toEqual(['KAS001GP']);
    });
  });

  describe('registering and allocating', () => {
    it('fits a tracker to a specific fleet owner\'s bike', async () => {
      const res = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user))
        .send({ imei: '350000000000222', model: 'FMB920', bike_id: bikeB.id });
      expect(res.status).toBe(201);

      const { rows } = await pgDb.query(
        'SELECT bike_id FROM tracking_devices WHERE imei = $1', ['350000000000222']);
      expect(rows[0].bike_id).toBe(bikeB.id);
    });

    it('moves a tracker from one fleet\'s bike to another\'s', async () => {
      const created = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000333', bike_id: bikeA.id });

      const res = await request(app).put(`/api/tracking/devices/${created.body.id}`)
        .set(authHeader(superadmin.user)).send({ bike_id: bikeB.id });
      expect(res.status).toBe(200);

      const { rows } = await pgDb.query('SELECT bike_id FROM tracking_devices WHERE id = $1', [created.body.id]);
      expect(rows[0].bike_id).toBe(bikeB.id);

      // Which customer's bike a tracker moved off matters when somebody later
      // asks why a fleet went dark.
      const { rows: audit } = await pgDb.query(
        `SELECT action FROM audit_logs WHERE action = 'tracking.device_relink'`);
      expect(audit).toHaveLength(1);
    });

    // Both used to go straight into the insert: a missing bike surfaced as a
    // 500 from the foreign key, and a walk-in was accepted silently.
    it('refuses a bike that does not exist', async () => {
      const res = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000444', bike_id: 999999 });
      expect(res.status).toBe(400);
    });

    it('refuses a walk-in workshop bike', async () => {
      const walkin = await walkInBike('WALKIN2');
      const res = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000555', bike_id: walkin.id });
      expect(res.status).toBe(400);
    });

    it('still allows a device with no bike yet', async () => {
      const res = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000666' });
      expect(res.status).toBe(201);
    });
  });

  describe('what a fleet owner may not do', () => {
    it.each([
      ['register a device', 'post', '/api/tracking/devices'],
      ['see the allocation list', 'get', '/api/tracking/allocatable-bikes'],
    ])('cannot %s', async (_label, method, path) => {
      const res = await request(app)[method](path)
        .set(authHeader(fleetOwner.user))
        .send({ imei: '350000000000777', bike_id: bikeA.id });
      expect(res.status).toBe(403);
    });

    it('cannot re-link somebody\'s tracker to its own bike', async () => {
      const created = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000888', bike_id: bikeB.id });

      const res = await request(app).put(`/api/tracking/devices/${created.body.id}`)
        .set(authHeader(fleetOwner.user)).send({ bike_id: bikeA.id });
      expect(res.status).toBe(403);

      const { rows } = await pgDb.query('SELECT bike_id FROM tracking_devices WHERE id = $1', [created.body.id]);
      expect(rows[0].bike_id, 'a fleet owner moved another fleet\'s tracker onto their own bike').toBe(bikeB.id);
    });

    it('cannot delete a device', async () => {
      const created = await request(app).post('/api/tracking/devices')
        .set(authHeader(superadmin.user)).send({ imei: '350000000000999', bike_id: bikeA.id });
      const res = await request(app).delete(`/api/tracking/devices/${created.body.id}`)
        .set(authHeader(fleetOwner.user));
      expect(res.status).toBe(403);
    });
  });
});
