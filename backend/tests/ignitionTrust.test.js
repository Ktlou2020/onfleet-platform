import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const ignitionTrust = load('../src/services/ignitionTrust.js');
const tripService = load('../src/services/tripService.js');
const nightCurfew = load('../src/services/nightCurfew.js');

// LY24JZGP raised "possible towing" twice in one afternoon while its rider was
// simply riding it. Its tracker reports the ignition element, but reports it
// as 0 for ever, because the ignition wire was never connected — so every ride
// reads as road distance covered with the ignition off, which is the exact
// definition of a tow.
//
// A present-but-dead ignition line cannot be told from a switched-off bike in
// any one ping. Over a tracker's life it is obvious: a wired one reads on the
// first time somebody turns the key.
describe.skipIf(!process.env.DATABASE_URL)('believing a tracker\'s ignition line', () => {
  let bike;
  let deviceId;

  let day = 100;
  const at = (offsetSec) => new Date(Date.UTC(2026, 0, day, 12, 0, offsetSec)).toISOString();

  // Ride far enough and long enough to clear the towing debounce
  // (60 seconds sustained, 150 metres covered, over 8 km/h).
  const rideWith = async (ignition) => {
    await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 45, ignition, at(0), {}, 120);
    await tripService.processPing(bike.id, deviceId, -26.2100, 28.0473, 45, ignition, at(90), {}, 120);
    await tripService.processPing(bike.id, deviceId, -26.2160, 28.0473, 45, ignition, at(180), {}, 120);
  };

  const alertTypes = async () => {
    const { rows } = await pgDb.query(
      'SELECT alert_type FROM tracking_alerts WHERE bike_id = $1 ORDER BY id', [bike.id]);
    return rows.map((r) => r.alert_type);
  };
  const tripCount = async () => {
    const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM trips WHERE bike_id = $1', [bike.id]);
    return rows[0].n;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    ignitionTrust.reset();
    nightCurfew.clearAll();
    tripService.__resetForTests();
    day += 1;
    bike = await createPgBike({ registration: 'LY24JZGP' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id) VALUES ($1,'FMB920',$2) RETURNING id`,
      [`3532013517${Math.floor(Math.random() * 100000)}`, bike.id]);
    deviceId = rows[0].id;
  });

  describe('a tracker whose ignition wire was never connected', () => {
    it('does not cry towing every time the bike is ridden', async () => {
      await rideWith(0);
      expect(await alertTypes()).not.toContain('towing');
    });

    it('does not call the same ride unauthorised movement either', async () => {
      await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 45, 0, at(0), { 240: 1 }, 120);
      expect(await alertTypes()).not.toContain('movement');
    });

    // The same dead 0 also meant this bike recorded no trips at all, so its
    // odometer never moved and its service was never due.
    it('still records the trip, from movement instead', async () => {
      await rideWith(0);
      expect(await tripCount()).toBe(1);
    });
  });

  describe('a tracker that has proved its ignition works', () => {
    const proveItWorks = async () => {
      await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 20, 1, at(-600), {}, 120);
      expect(ignitionTrust.isTrusted(deviceId)).toBe(true);
    };

    it('is believed from the first time the key is turned', async () => {
      expect(ignitionTrust.isTrusted(deviceId)).toBe(false);
      await proveItWorks();
    });

    it('remembers it, so one ride is enough for good', async () => {
      await proveItWorks();
      const { rows } = await pgDb.query('SELECT ignition_trusted_at FROM tracking_devices WHERE id = $1', [deviceId]);
      expect(rows[0].ignition_trusted_at).toBeTruthy();

      ignitionTrust.reset();
      await ignitionTrust.prime();
      expect(ignitionTrust.isTrusted(deviceId)).toBe(true);
    });

    // The point of all this is that a real tow is still caught.
    it('still raises towing when that bike really is moved with the ignition off', async () => {
      await proveItWorks();
      await rideWith(0);
      expect(await alertTypes()).toContain('towing');
    });

    it('still raises unauthorised movement', async () => {
      await proveItWorks();
      await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 45, 0, at(0), { 240: 1 }, 120);
      expect(await alertTypes()).toContain('movement');
    });
  });

  // A fleet that has been running for months should not spend a ride per
  // tracker with towing detection suppressed while each one re-proves itself.
  describe('working it out from history', () => {
    it('trusts a tracker that has reported ignition on before', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, ignition)
         VALUES ($1, -26.2, 28.0, 30, NOW() - INTERVAL '2 days', 1)`, [bike.id]);

      expect(await ignitionTrust.backfillFromPings()).toBe(1);
      expect(ignitionTrust.isTrusted(deviceId)).toBe(true);
    });

    it('leaves a tracker that has only ever reported it off', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, ignition)
         VALUES ($1, -26.2, 28.0, 30, NOW() - INTERVAL '2 days', 0),
                ($1, -26.3, 28.1, 45, NOW() - INTERVAL '1 day', 0)`, [bike.id]);

      expect(await ignitionTrust.backfillFromPings()).toBe(0);
      expect(ignitionTrust.isTrusted(deviceId)).toBe(false);
    });

    it('ignores an ignition-on from long ago', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, ignition)
         VALUES ($1, -26.2, 28.0, 30, NOW() - INTERVAL '200 days', 1)`, [bike.id]);

      expect(await ignitionTrust.backfillFromPings(30)).toBe(0);
    });
  });

  describe('finding the badly installed trackers', () => {
    it('lists a tracker whose ignition has never been seen on', async () => {
      const list = await ignitionTrust.untrustedDevices();
      expect(list.map((d) => d.registration)).toContain('LY24JZGP');
    });

    it('drops it from the list once the key has been turned', async () => {
      await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 20, 1, at(0), {}, 120);
      const list = await ignitionTrust.untrustedDevices();
      expect(list.map((d) => d.registration)).not.toContain('LY24JZGP');
    });
  });

  describe('the install check', () => {
    const ignitionCheck = async () => {
      const { runChecks } = load('../src/services/deviceCommissioning.js');
      const result = await runChecks(deviceId);
      return result.checks.find((c) => c.id === 'ignition');
    };

    // It used to pass on element 239 merely being present — which is exactly
    // what a dead wire reports — so a bad install was signed off as good.
    it('fails while the ignition has only ever read off', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, ignition, io_data)
         VALUES ($1, -26.2, 28.0, 30, NOW(), 0, '{"239":0}')`, [bike.id]);
      const check = await ignitionCheck();
      expect(check.passed).toBe(false);
      expect(check.detail).toMatch(/turn the key/i);
    });

    it('passes once it has been seen on', async () => {
      await pgDb.query(
        `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, ignition, io_data)
         VALUES ($1, -26.2, 28.0, 30, NOW(), 1, '{"239":1}')`, [bike.id]);
      await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 20, 1, at(0), {}, 120);
      expect((await ignitionCheck()).passed).toBe(true);
    });
  });

  // The overnight curfew reasons from movement and the clock, never from the
  // ignition — so a dead ignition wire must not quietly exempt a bike from it.
  it('does not change what the overnight curfew sees', async () => {
    const nightAt = (s) => new Date(Date.UTC(2026, 0, day, 23, 0, s)).toISOString();
    await tripService.processPing(bike.id, deviceId, -26.2041, 28.0473, 45, 0, nightAt(0), {}, 120);
    await tripService.processPing(bike.id, deviceId, -26.2059, 28.0473, 45, 0, nightAt(100), {}, 120);
    expect(nightCurfew.isArmed(bike.id)).toBe(true);
  });
});
