import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const tripService = load('../src/services/tripService.js');
const nightCurfew = load('../src/services/nightCurfew.js');
const ignitionTrust = load('../src/services/ignitionTrust.js');

// Alerts raised on a fix nobody should have believed.
//
// MH28YTGP came back as 1.2 km travelled in 26 minutes with a top speed of
// 106 km/h — a parked bike whose GNSS had gone to sleep and was reporting a
// wandering position and a speed to match. The trip measurement was the
// visible symptom; the alerts were the expensive one. The same run of pings
// reads as towing (ignition off, "moving", position "displaced"), as night
// movement if it happens after midnight, and as speeding.
//
// The existing defences were sustained-time and minimum-displacement, and the
// comments in the source say what they were for: so that ONE glitchy ping
// could not fire a critical alert. That is a real guard against a single
// outlier and no guard at all against what a sleeping receiver actually
// produces, which is a steady stream of them — sustained for minutes, and
// displaced by kilometres.
//
// Night movement is the one that costs something. It does not just alert: it
// arms the curfew, and the curfew cuts the engine by itself.

const LAT = -26.2041;
const LNG = 28.0473;
const AWAY = 0.02; // about 2.2 km — well past every displacement threshold
const GOOD = 9;
const BAD = 1;

describe.skipIf(!process.env.DATABASE_URL)('a parked bike whose receiver is asleep', () => {
  let bike, deviceId;
  // TRUNCATE hands every test the same bike id, and the alert cooldowns live
  // in module memory keyed on it, so each test rides on its own day.
  let day = 200;

  // 23:00 UTC is 01:00 SAST — inside the curfew window, and SAST has no DST.
  const nightAt = (sec) => new Date(Date.UTC(2026, 0, day, 23, 0, sec)).toISOString();
  // 10:00 UTC is midday SAST.
  const dayAt = (sec) => new Date(Date.UTC(2026, 0, day, 10, 0, sec)).toISOString();

  const ping = (at, lat, lng, speed, ignition, satellites) =>
    tripService.processPing(bike.id, deviceId, lat, lng, speed, ignition, at, null, 120, satellites);

  const alertTypes = async () => {
    const { rows } = await pgDb.query(
      'SELECT alert_type FROM tracking_alerts WHERE bike_id = $1 ORDER BY id', [bike.id]);
    return rows.map((r) => r.alert_type);
  };
  const isCut = async () => (await pgDb.query(
    'SELECT engine_cut_active FROM tracking_devices WHERE id = $1', [deviceId])).rows[0].engine_cut_active;
  const settle = () => new Promise((r) => setTimeout(r, 80));

  beforeEach(async () => {
    await resetAllPgTables();
    tripService.__resetForTests();
    nightCurfew.clearAll();
    nightCurfew.reloadSettings();
    ignitionTrust.reset();
    day += 1;
    bike = await createPgBike({ registration: 'MH28YTGP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id) VALUES ($1,'FMB920',$2) RETURNING id`,
      [`3532013599${Math.floor(Math.random() * 100000)}`, bike.id]);
    deviceId = rows[0].id;
    // Towing detection is suppressed on a tracker that has never reported its
    // ignition on, because a dead ignition wire reads as a permanent tow (see
    // ignitionTrust). Turn the key once so this bike's towing tests are about
    // fix quality and nothing else.
    await tripService.processPing(bike.id, deviceId, LAT, LNG, 20, 1, dayAt(-600), null, 120, GOOD);
    expect(ignitionTrust.isTrusted(deviceId)).toBe(true);
    await pgDb.query('DELETE FROM tracking_alerts WHERE bike_id = $1', [bike.id]);
    tripService.__resetForTests();
  });

  afterEach(() => nightCurfew.clearAll());

  // Three pings a minute and a half apart, each claiming highway speed and a
  // position two kilometres from the last. Sustained: yes. Displaced: yes.
  // Satellites: one.
  const sleepwalk = async (at, ignition, satellites) => {
    await ping(at(0), LAT, LNG, 106, ignition, satellites);
    await ping(at(90), LAT + AWAY, LNG, 104, ignition, satellites);
    await ping(at(180), LAT + 2 * AWAY, LNG, 106, ignition, satellites);
  };

  describe('with the ignition off, in daylight', () => {
    it('is not reported as being towed', async () => {
      await sleepwalk(dayAt, 0, BAD);
      expect(await alertTypes()).not.toContain('towing');
    });

    // The control. Without this the test above passes just as well on a build
    // where towing detection is broken outright.
    it('but the same pings on a good fix still are', async () => {
      await sleepwalk(dayAt, 0, GOOD);
      expect(await alertTypes()).toContain('towing');
    });
  });

  describe('at one in the morning', () => {
    it('is not reported as night movement', async () => {
      await sleepwalk(nightAt, 1, BAD);
      expect(await alertTypes()).not.toContain('night_movement');
    });

    // The expensive half. An alert is noise; this is a bike that cannot be
    // started in the morning because nothing ever moved it.
    it('does not have its engine cut', async () => {
      await sleepwalk(nightAt, 1, BAD);
      // A later ping at walking pace is what fires the cut on an armed bike.
      await ping(nightAt(240), LAT + 2 * AWAY, LNG, 2, 1, BAD);
      await settle();

      expect(nightCurfew.isArmed(bike.id)).toBe(false);
      expect(await isCut()).toBe(false);
    });

    it('but a bike really being ridden at that hour is still cut', async () => {
      await sleepwalk(nightAt, 1, GOOD);
      expect(nightCurfew.isArmed(bike.id)).toBe(true);
      await ping(nightAt(240), LAT + 2 * AWAY, LNG, 2, 1, GOOD);
      await settle();

      expect(await isCut()).toBe(true);
    });
  });

  describe('and the speed that came with the bad fix', () => {
    it('is not treated as speeding', async () => {
      await ping(dayAt(0), LAT, LNG, 160, 1, BAD);
      expect(await alertTypes()).not.toContain('speeding');
    });

    it('while a real 160 km/h still is', async () => {
      await ping(dayAt(0), LAT, LNG, 160, 1, GOOD);
      expect(await alertTypes()).toContain('speeding');
    });
  });

  // The other direction, and the reason an untrusted fix clears nothing.
  //
  // A bike on the back of a bakkie goes under a bridge. If a bad fix reset the
  // towing streak, a thief could be handed an indefinite reprieve by ordinary
  // urban GPS shadow — and the streak would restart from scratch every time,
  // so the alert would never fire at all.
  describe('a genuine tow that loses the sky for a moment', () => {
    it('still raises towing once the fix comes back', async () => {
      await ping(dayAt(0), LAT, LNG, 40, 0, GOOD);
      await ping(dayAt(45), LAT + 0.01, LNG, 39, 0, BAD); // under a bridge
      await ping(dayAt(90), LAT + AWAY, LNG, 41, 0, GOOD);

      expect(await alertTypes()).toContain('towing');
    });

    it('and the streak is measured from the last fix worth measuring from', async () => {
      await ping(dayAt(0), LAT, LNG, 40, 0, GOOD);
      await ping(dayAt(45), LAT + 0.01, LNG, 39, 0, BAD);
      await ping(dayAt(90), LAT + AWAY, LNG, 41, 0, GOOD);

      const { rows } = await pgDb.query(
        `SELECT payload FROM tracking_alerts WHERE bike_id=$1 AND alert_type='towing'`, [bike.id]);
      const payload = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
      // 90 seconds from the first good fix, not 45 from the bad one.
      expect(payload.sustained_sec).toBe(90);
    });
  });

  // An armed bike is cut the moment it drops to walking pace, so that the
  // engine never dies under somebody at speed. A fix that cannot be trusted to
  // give a position cannot be trusted to give a speed either, and treating a
  // phantom 0 km/h as walking pace would cut a bike doing eighty.
  describe('an armed bike reporting an untrusted speed', () => {
    it('is not cut on a phantom zero', async () => {
      await sleepwalk(nightAt, 1, GOOD); // genuinely armed
      expect(nightCurfew.isArmed(bike.id)).toBe(true);

      await ping(nightAt(240), LAT + 2 * AWAY, LNG, 0, 1, BAD);
      await settle();

      expect(await isCut()).toBe(false);
      expect(nightCurfew.isArmed(bike.id)).toBe(true); // still waiting, not forgotten
    });
  });
});
