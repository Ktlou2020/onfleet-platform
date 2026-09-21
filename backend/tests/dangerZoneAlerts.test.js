import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

// The services reach each other with require(), and an ESM import of the same
// file is a separate copy with its own caches — so the settings this test
// changes must be reloaded on the copy geofenceService actually talks to.
const load = createRequire(import.meta.url);
const geofenceService = load('../src/services/geofenceService.js');
const tripService = load('../src/services/tripService.js');

async function reloadSettings() {
  tripService.reloadAlertSettings();
  await new Promise((r) => setTimeout(r, 60));
}

// A no-go zone exists for one moment: a bike goes into it. That moment used to
// raise `geofence_enter` — the same alert as arriving at the depot, at medium
// severity — which meant it could not be switched on, routed or escalated on
// its own, and read as unremarkable in the control room.
describe.skipIf(!process.env.DATABASE_URL)('entering a no-go zone', () => {
  let bike;
  let deviceId;

  // The zone sits on a point the bike can be placed inside or outside of.
  const ZONE = { lat: -26.2041, lng: 28.0473, radius: 500 };
  const INSIDE = [-26.2041, 28.0473];
  const OUTSIDE = [-26.3500, 28.2000];

  const makeZone = async (zoneType, name = 'Test zone') => {
    const { rows } = await pgDb.query(
      `INSERT INTO geofences (name, lat, lng, radius_m, zone_type, active) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING *`,
      [name, ZONE.lat, ZONE.lng, ZONE.radius, zoneType]);
    geofenceService.reloadGeofences();
    await new Promise((r) => setTimeout(r, 60)); // the cache reloads out of band
    return rows[0];
  };

  const ping = ([lat, lng], at = new Date().toISOString()) =>
    geofenceService.checkGeofences(bike.id, deviceId, lat, lng, at);

  const alerts = async () => {
    const { rows } = await pgDb.query(
      'SELECT alert_type, severity, payload FROM tracking_alerts WHERE bike_id = $1 ORDER BY id', [bike.id]);
    return rows;
  };
  const types = async () => (await alerts()).map((a) => a.alert_type);

  beforeEach(async () => {
    await resetAllPgTables();
    bike = await createPgBike({ registration: 'LW78MDGP' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id) VALUES ($1,'FMB920',$2) RETURNING id`,
      [`35320135231${Math.floor(Math.random() * 10000)}`, bike.id]);
    deviceId = rows[0].id;
    await reloadSettings();
  });

  it('raises its own alert, not a plain geofence entry', async () => {
    await makeZone('danger', 'Hillbrow no-go');
    await ping(OUTSIDE);          // establishes "outside" without alerting
    await ping(INSIDE);

    const raised = await alerts();
    const entry = raised.find((a) => a.alert_type === 'danger_zone_enter');
    expect(entry).toBeTruthy();
    expect(raised.map((a) => a.alert_type)).not.toContain('geofence_enter');
    expect(JSON.parse(entry.payload).geofence_name).toBe('Hillbrow no-go');
  });

  it('raises it as critical, so it is chased until somebody answers', async () => {
    await makeZone('danger');
    await ping(OUTSIDE);
    await ping(INSIDE);

    const entry = (await alerts()).find((a) => a.alert_type === 'danger_zone_enter');
    expect(entry.severity).toBe('critical');

    const { CRITICAL_TYPES } = load('../src/services/alertEscalationService.js');
    expect(CRITICAL_TYPES).toContain('danger_zone_enter');
  });

  it('leaves an ordinary zone alone', async () => {
    await makeZone('standard', 'Depot');
    await ping(OUTSIDE);
    await ping(INSIDE);

    expect(await types()).toContain('geofence_enter');
    expect(await types()).not.toContain('danger_zone_enter');
  });

  // Riding back out is good news, and used to arrive as a high-severity
  // "Left geofence" — the same alert as a bike leaving its working area.
  it('says so plainly when the bike comes back out', async () => {
    await makeZone('danger');
    await ping(OUTSIDE);
    await ping(INSIDE);
    await ping(OUTSIDE);

    const out = (await alerts()).find((a) => a.alert_type === 'danger_zone_exit');
    expect(out).toBeTruthy();
    expect(out.severity).toBe('low');
    expect(await types()).not.toContain('geofence_exit');
  });

  it('does not re-raise while the bike stays inside', async () => {
    await makeZone('danger');
    await ping(OUTSIDE);
    await ping(INSIDE);
    await ping(INSIDE);
    await ping(INSIDE);

    expect((await types()).filter((t) => t === 'danger_zone_enter')).toHaveLength(1);
  });

  // The engine cut is the zone's teeth. It is deliberately not gated on the
  // alert type being switched on.
  it('still cuts the engine, and says why', async () => {
    await makeZone('danger', 'Chop-shop road');
    await ping(OUTSIDE);
    await ping(INSIDE);
    await new Promise((r) => setTimeout(r, 120)); // the cut is fired and not awaited

    const { rows } = await pgDb.query(
      'SELECT engine_cut_active, engine_cut_reason FROM tracking_devices WHERE id = $1', [deviceId]);
    expect(rows[0].engine_cut_active).toBe(true);
    expect(rows[0].engine_cut_reason).toContain('Chop-shop road');
  });

  describe('when an admin switches the type off', () => {
    const disable = async (type) => {
      await pgDb.query(
        `INSERT INTO alert_settings (alert_type, enabled, notify_enabled) VALUES ($1, FALSE, FALSE)
         ON CONFLICT (alert_type) DO UPDATE SET enabled = FALSE, notify_enabled = FALSE`, [type]);
      await reloadSettings();
    };

    // The switch claimed to stop an alert being raised; for zone alerts it did
    // nothing at all, because this path inserted its own row and never
    // consulted the settings.
    it('stops raising it', async () => {
      await makeZone('danger');
      await disable('danger_zone_enter');
      await ping(OUTSIDE);
      await ping(INSIDE);

      expect(await types()).not.toContain('danger_zone_enter');
    });

    it('still remembers which side of the line the bike is on', async () => {
      const zone = await makeZone('danger');
      await disable('danger_zone_enter');
      await ping(OUTSIDE);
      await ping(INSIDE);

      const { rows } = await pgDb.query(
        'SELECT inside FROM geofence_states WHERE bike_id = $1 AND geofence_id = $2', [bike.id, zone.id]);
      expect(rows[0].inside).toBe(true);

      // …so leaving still reads as leaving, rather than as a fresh entry.
      await ping(OUTSIDE);
      expect(await types()).toContain('danger_zone_exit');
    });

    it('still cuts the engine — the zone does not stop working', async () => {
      await makeZone('danger');
      await disable('danger_zone_enter');
      await ping(OUTSIDE);
      await ping(INSIDE);
      await new Promise((r) => setTimeout(r, 120));

      const { rows } = await pgDb.query('SELECT engine_cut_active FROM tracking_devices WHERE id = $1', [deviceId]);
      expect(rows[0].engine_cut_active).toBe(true);
    });
  });

  it('is offered to an admin as its own setting', async () => {
    const { ALL_ALERT_TYPES, ALERT_SEVERITY } = load('../src/constants/alertTypes.js');
    expect(ALL_ALERT_TYPES).toContain('danger_zone_enter');
    expect(ALL_ALERT_TYPES).toContain('danger_zone_exit');
    expect(ALERT_SEVERITY.danger_zone_enter).toBe('critical');
  });
});
