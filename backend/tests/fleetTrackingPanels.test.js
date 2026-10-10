import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// The panels the fleet tracking screen needs to match the admin one.
//
// Every one of these is the org-scoped twin of an /api/tracking route, and
// every one is a place a fleet could read another fleet's vehicle. The
// ownership check used to be written out longhand in each handler; these
// tests are what stop the next one being added without it.
//
// All refusals are 404 and not 403, so a fleet cannot learn that a device or
// a bike exists from the way it is told no.

describe.skipIf(!process.env.DATABASE_URL)('fleet tracking panels', () => {
  let orgA, orgB, ownerA, bikeA, bikeB, deviceA, deviceB;

  const addDevice = async (bikeId, imei) => {
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model, connected)
       VALUES ($1,$2,'FMB920',true) RETURNING *`, [imei, bikeId]);
    return rows[0];
  };

  beforeEach(async () => {
    await resetAllPgTables();
    orgA = await createPgOrg({ name: 'Rapid Wheels' });
    orgB = await createPgOrg({ name: 'Kasi Couriers' });
    await pgDb.query(
      `UPDATE organizations SET status='active', subscription_status='active', subscription_tier='complete'
        WHERE id = ANY($1)`, [[orgA.id, orgB.id]]);

    ownerA = await createPgUser({ role: 'fleet_owner_admin', organization_id: orgA.id });
    bikeA = await createPgBike({ registration: 'RAP001GP', organization_id: orgA.id });
    bikeB = await createPgBike({ registration: 'KAS001GP', organization_id: orgB.id });
    deviceA = await addDevice(bikeA.id, '350000000000001');
    deviceB = await addDevice(bikeB.id, '350000000000002');
  });

  const asA = () => authHeader(ownerA.user);

  describe('trips', () => {
    beforeEach(() => pgDb.query(
      `INSERT INTO trips (bike_id, device_id, started_at, ended_at, distance_km, duration_sec, max_speed_kmh, avg_speed_kmh)
       VALUES ($1,$2, NOW() - interval '2 hours', NOW() - interval '1 hour', 12.5, 3600, 68, 31)`,
      [bikeA.id, deviceA.id]));

    it('lists its own bike\'s trips', async () => {
      const res = await request(app).get(`/api/fleet/tracking/trips?bike_id=${bikeA.id}`).set(asA());
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(Number(res.body[0].distance_km)).toBe(12.5);
    });

    // Same shape as /api/tracking/trips/stats, field for field. The first
    // version of this endpoint returned a tidier shape of its own invention,
    // and the shared component crashed reading a key that was not there.
    it('summarises today and the week in the shape the screen reads', async () => {
      const res = await request(app).get(`/api/fleet/tracking/trips/stats?bike_id=${bikeA.id}`).set(asA());
      expect(res.status).toBe(200);
      expect(res.body.week).toMatchObject({ trips: 1, km: 12.5, sec: 3600, top_speed_kmh: 68 });
      expect(res.body.today).toBeDefined();
    });

    it.each([
      ['trips', `/api/fleet/tracking/trips?bike_id=`],
      ['trip stats', `/api/fleet/tracking/trips/stats?bike_id=`],
    ])('cannot read another fleet\'s %s', async (_label, path) => {
      const res = await request(app).get(`${path}${bikeB.id}`).set(asA());
      expect(res.status).toBe(404);
    });
  });

  describe('bike notes', () => {
    it('writes and reads a note on its own bike', async () => {
      const made = await request(app).post(`/api/fleet/tracking/bikes/${bikeA.id}/notes`)
        .set(asA()).send({ note: 'Chain needs tensioning', for_workshop: true });
      expect(made.status).toBe(201);

      const res = await request(app).get(`/api/fleet/tracking/bikes/${bikeA.id}/notes`).set(asA());
      expect(res.body).toHaveLength(1);
      expect(res.body[0].note).toBe('Chain needs tensioning');
      expect(res.body[0].author_name, 'the field the shared component reads').toBe(ownerA.user.full_name);
    });

    it('refuses an empty note rather than storing a blank', async () => {
      const res = await request(app).post(`/api/fleet/tracking/bikes/${bikeA.id}/notes`)
        .set(asA()).send({ note: '   ' });
      expect(res.status).toBe(400);
    });

    it.each([['read', 'get'], ['write', 'post']])('cannot %s notes on another fleet\'s bike', async (_l, method) => {
      const res = await request(app)[method](`/api/fleet/tracking/bikes/${bikeB.id}/notes`)
        .set(asA()).send({ note: 'not mine' });
      expect(res.status).toBe(404);

      const { rows } = await pgDb.query('SELECT COUNT(*)::int AS n FROM bike_notes WHERE bike_id = $1', [bikeB.id]);
      expect(rows[0].n, 'a note was written onto another fleet\'s bike').toBe(0);
    });
  });

  describe('geofences', () => {
    beforeEach(async () => {
      await pgDb.query(
        `INSERT INTO geofences (name, lat, lng, radius_m, bike_id, active, zone_type)
         VALUES ('Depot A', -26.1, 28.0, 500, $1, true, 'standard'),
                ('Depot B', -26.2, 28.1, 500, $2, true, 'standard')`, [bikeA.id, bikeB.id]);
      // A platform-wide zone, belonging to the operator rather than a fleet.
      await pgDb.query(
        `INSERT INTO geofences (name, lat, lng, radius_m, bike_id, active, zone_type)
         VALUES ('Operator no-go', -26.3, 28.2, 900, NULL, true, 'danger')`);
    });

    it('sees only the zones on its own bikes', async () => {
      const res = await request(app).get('/api/fleet/tracking/geofences').set(asA());
      expect(res.status).toBe(200);
      expect(res.body.map((g) => g.name)).toEqual(['Depot A']);
    });

    // geofences has no organization_id, so getting this wrong would hand one
    // customer the operator's own no-go areas.
    it('and not the operator\'s platform-wide ones', async () => {
      const res = await request(app).get('/api/fleet/tracking/geofences').set(asA());
      expect(res.body.map((g) => g.name)).not.toContain('Operator no-go');
    });
  });

  describe('the command log', () => {
    beforeEach(() => pgDb.query(
      `INSERT INTO tracking_commands (device_id, command, status) VALUES ($1,'setdigout 1','sent')`,
      [deviceA.id]));

    it('shows what was sent to its own device', async () => {
      const res = await request(app).get(`/api/fleet/tracking/devices/${deviceA.id}/commands`).set(asA());
      expect(res.status).toBe(200);
      expect(res.body[0].command).toBe('setdigout 1');
    });

    it('cannot read another fleet\'s', async () => {
      const res = await request(app).get(`/api/fleet/tracking/devices/${deviceB.id}/commands`).set(asA());
      expect(res.status).toBe(404);
    });

    // A device with no bike has no owner, so it belongs to nobody's fleet.
    it('cannot read an unassigned device\'s', async () => {
      const loose = await addDevice(null, '350000000000009');
      const res = await request(app).get(`/api/fleet/tracking/devices/${loose.id}/commands`).set(asA());
      expect(res.status).toBe(404);
    });
  });

  // The fleet mount and the platform mount feed the same component, so a
  // field present in one response and absent from the other is a blank panel
  // or a crash. These pin the keys the screen actually reads.
  describe('shapes the shared screen depends on', () => {
    it('the device list carries a status the markers can use', async () => {
      const res = await request(app).get('/api/fleet/tracking/devices').set(asA());
      expect(res.status).toBe(200);
      expect(res.body[0]).toHaveProperty('device_status');
      expect(['active', 'sleeping', 'offline']).toContain(res.body[0].device_status);
    });

    it('the single device carries the same, plus its bike', async () => {
      const res = await request(app).get(`/api/fleet/tracking/devices/${deviceA.id}`).set(asA());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('device_status');
      expect(res.body.registration).toBe('RAP001GP');
      // The join column is internal and should not leak into the response.
      expect(res.body.bike_org_id).toBeUndefined();
    });
  });

  // Alert settings, for a fleet.
  //
  // alert_settings is one platform-wide table; a fleet writing to it would
  // change what every other customer is alerted about. device_alert_settings
  // is per device and a device belongs to one fleet, so that is the only
  // part a customer owns.
  describe('alert settings', () => {
    const settings = [{ alert_type: 'movement', enabled: false, notify_enabled: false, recipient_user_ids: [] }];

    it('shows the inherited defaults and marks them not editable without a device', async () => {
      const res = await request(app).get('/api/fleet/tracking/alert-settings').set(asA());
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('alert_type');
      expect(res.body.every((r) => r.editable === false), 'the platform defaults were offered as editable').toBe(true);
    });

    it('sets an override on its own device', async () => {
      const res = await request(app).put('/api/fleet/tracking/alert-settings')
        .set(asA()).send({ device_id: deviceA.id, settings });
      expect(res.status).toBe(200);

      const { rows } = await pgDb.query(
        'SELECT enabled FROM device_alert_settings WHERE device_id = $1 AND alert_type = $2',
        [deviceA.id, 'movement']);
      expect(rows[0].enabled).toBe(false);
    });

    it('reads its own override back as an override', async () => {
      await request(app).put('/api/fleet/tracking/alert-settings')
        .set(asA()).send({ device_id: deviceA.id, settings });
      const res = await request(app).get(`/api/fleet/tracking/alert-settings?device_id=${deviceA.id}`).set(asA());
      const movement = res.body.find((r) => r.alert_type === 'movement');
      expect(movement.device_override).toBe(true);
      expect(movement.enabled).toBe(false);
      expect(movement.editable).toBe(true);
    });

    // The one that matters. Without a device this used to mean "write the
    // platform-wide row", which is every other customer's settings.
    it('refuses to write without a device rather than falling through to global', async () => {
      const before = await pgDb.query('SELECT COUNT(*)::int AS n FROM alert_settings');
      const res = await request(app).put('/api/fleet/tracking/alert-settings').set(asA()).send({ settings });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DEVICE_REQUIRED');

      const after = await pgDb.query('SELECT COUNT(*)::int AS n FROM alert_settings');
      expect(after.rows[0].n, 'a fleet wrote to the platform-wide alert settings').toBe(before.rows[0].n);
    });

    it('cannot set an override on another fleet\'s device', async () => {
      const res = await request(app).put('/api/fleet/tracking/alert-settings')
        .set(asA()).send({ device_id: deviceB.id, settings });
      expect(res.status).toBe(400);

      const { rows } = await pgDb.query(
        'SELECT COUNT(*)::int AS n FROM device_alert_settings WHERE device_id = $1', [deviceB.id]);
      expect(rows[0].n, 'a fleet changed another fleet\'s alert settings').toBe(0);
    });

    // "Apply to all" means every device this fleet owns, not every device on
    // the platform, which is what it means on the operator's side.
    it('applies to all of its own devices and none of anybody else\'s', async () => {
      const second = await createPgBike({ registration: 'RAP002GP', organization_id: orgA.id });
      const secondDevice = await addDevice(second.id, '350000000000003');

      const res = await request(app).put('/api/fleet/tracking/alert-settings')
        .set(asA()).send({ apply_to_all: true, settings });
      expect(res.status).toBe(200);
      expect(res.body.devices).toBe(2);

      const { rows } = await pgDb.query(
        'SELECT device_id FROM device_alert_settings WHERE alert_type = $1 ORDER BY device_id', ['movement']);
      expect(rows.map((r) => r.device_id).sort()).toEqual([deviceA.id, secondDevice.id].sort());
    });

    it('clears its own device\'s overrides', async () => {
      await request(app).put('/api/fleet/tracking/alert-settings')
        .set(asA()).send({ device_id: deviceA.id, settings });
      const res = await request(app).delete(`/api/fleet/tracking/alert-settings/device/${deviceA.id}`).set(asA());
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query(
        'SELECT COUNT(*)::int AS n FROM device_alert_settings WHERE device_id = $1', [deviceA.id]);
      expect(rows[0].n).toBe(0);
    });

    it('cannot clear another fleet\'s', async () => {
      const res = await request(app).delete(`/api/fleet/tracking/alert-settings/device/${deviceB.id}`).set(asA());
      expect(res.status).toBe(404);
    });
  });

  describe('who can be notified', () => {
    it('lists this fleet\'s own people', async () => {
      const res = await request(app).get('/api/fleet/tracking/notification-users').set(asA());
      expect(res.status).toBe(200);
      expect(res.body.map((u) => u.id)).toContain(ownerA.user.id);
    });

    // The platform twin lists admins and superadmins. Handing a customer a
    // directory of the operator's staff is not a feature.
    it('and not the operator\'s staff, nor another fleet\'s', async () => {
      const operator = await createPgUser({ role: 'superadmin' });
      const otherFleet = await createPgUser({ role: 'fleet_owner_admin', organization_id: orgB.id });

      const res = await request(app).get('/api/fleet/tracking/notification-users').set(asA());
      const ids = res.body.map((u) => u.id);
      expect(ids, 'a fleet was shown the operator\'s staff').not.toContain(operator.user.id);
      expect(ids, 'a fleet was shown another fleet\'s people').not.toContain(otherFleet.user.id);
    });
  });

  describe('still off limits', () => {
    // Fitting trackers is the operator's job; these are the admin routes the
    // fleet screen must never gain.
    it.each([
      ['register a device', 'post', '/api/tracking/devices'],
      ['see the allocation list', 'get', '/api/tracking/allocatable-bikes'],
    ])('a fleet owner cannot %s', async (_l, method, path) => {
      const res = await request(app)[method](path).set(asA()).send({ imei: '350000000000111' });
      expect(res.status).toBe(403);
    });
  });
});
