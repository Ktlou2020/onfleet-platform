import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const trips = load('../src/services/tripService.js');
const { MIN_TRUSTED_SATELLITES } = load('../src/constants/gps.js');

// A trip whose own numbers contradict each other.
//
// MH28YTGP came back as 1.2 km in 26 minutes with a top speed of 106 km/h.
// All three cannot be true: 26 minutes averaging under 3 km/h is a bike that
// barely moved. The 106 came from a ping with a fix too poor to trust — the
// same reading geofenceService refuses to open a zone on, and deviceHealth
// refuses to call a fault. Trips drew no line at all, so one bad ping set the
// trip's top speed for ever and dragged its distance out and back.

const LAT = -26.2041;
const LNG = 28.0473;
// 0.001 degrees of latitude is about 111 m.
const M111 = 0.001;

describe.skipIf(!process.env.DATABASE_URL)('measuring a trip that contains a bad fix', () => {
  let bike, deviceId, tripId;

  // Four hours ago, so the trip is stale enough for the reaper to close it.
  const startedAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const at = (sec) => new Date(startedAt.getTime() + sec * 1000);

  beforeEach(async () => {
    await resetAllPgTables();
    trips.__resetForTests();
    bike = await createPgBike({ status: 'active' });
    const { rows: dev } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, connected) VALUES ('trip-fix', $1, TRUE) RETURNING id`,
      [bike.id]);
    deviceId = dev[0].id;
    const { rows: t } = await pgDb.query(
      `INSERT INTO trips (bike_id, device_id, started_at, start_lat, start_lng)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [bike.id, deviceId, at(0), LAT, LNG]);
    tripId = t[0].id;
  });

  const addPing = (sec, lat, lng, speed, satellites) =>
    pgDb.query(
      `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at, satellites)
       VALUES ($1,$2,$3,$4,$5,$6)`, [bike.id, lat, lng, speed, at(sec), satellites]);

  const reap = async () => {
    await trips.closeStaleTrips();
    const { rows } = await pgDb.query(
      'SELECT distance_km, max_speed_kmh, avg_speed_kmh FROM trips WHERE id = $1', [tripId]);
    return rows[0];
  };

  // The bike crawls 222 m over three good fixes. One ping in the middle has a
  // single satellite, places the bike 2 km away, and claims 106 km/h.
  const crawlWithOneWildFix = async () => {
    await addPing(0,   LAT,             LNG, 10,  9);
    await addPing(30,  LAT + M111,      LNG, 12,  9);
    await addPing(60,  LAT + 0.02,      LNG, 106, 1);   // the wild one
    await addPing(90,  LAT + 2 * M111,  LNG, 11,  9);
  };

  it('does not let an untrusted fix become the trip top speed', async () => {
    await crawlWithOneWildFix();
    const trip = await reap();
    expect(Number(trip.max_speed_kmh)).toBe(12);
  });

  it('measures between the trusted fixes, not out to the bad one and back', async () => {
    await crawlWithOneWildFix();
    const trip = await reap();
    // Three good fixes 111 m apart: about 222 m. Going out to the wild fix and
    // back would have added roughly 4 km.
    expect(Number(trip.distance_km)).toBeGreaterThan(0.15);
    expect(Number(trip.distance_km)).toBeLessThan(0.35);
  });

  it('leaves the average speed reflecting the fixes it trusts', async () => {
    await crawlWithOneWildFix();
    const trip = await reap();
    // (10 + 12 + 11) / 3 = 11. Including the 106 would give 35.
    expect(Number(trip.avg_speed_kmh)).toBe(11);
  });

  it('still measures a genuine fast trip when every fix is good', async () => {
    await addPing(0,  LAT,            LNG, 60,  10);
    await addPing(30, LAT + 0.005,    LNG, 95,  11);
    await addPing(60, LAT + 0.010,    LNG, 106, 9);
    const trip = await reap();
    expect(Number(trip.max_speed_kmh)).toBe(106);
    expect(Number(trip.distance_km)).toBeGreaterThan(1);
  });

  // A device that sends no satellite count is not a device reporting a bad
  // fix. Discarding those would silently stop measuring every trip on a model
  // that does not report the field.
  it('trusts a ping that carries no satellite count at all', async () => {
    await addPing(0,  LAT,           LNG, 40, null);
    await addPing(30, LAT + 0.005,   LNG, 55, null);
    const trip = await reap();
    expect(Number(trip.max_speed_kmh)).toBe(55);
    expect(Number(trip.distance_km)).toBeGreaterThan(0.4);
  });
});

describe('the line itself', () => {
  it('is the same four satellites the rest of the platform refuses to act below', () => {
    expect(MIN_TRUSTED_SATELLITES).toBe(4);
  });
});
