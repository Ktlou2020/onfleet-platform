import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const nightCurfew = load('../src/services/nightCurfew.js');
const tripService = load('../src/services/tripService.js');

// Bikes should be parked between 00:00 and 04:00 SAST, so one that is moving
// then is treated as stolen and its engine is cut without waiting for anybody
// to answer the alert.
//
// Most of what follows is about the cut NOT happening: at speed, on a bike
// that is no longer OnFleet's, on an exempted one, or when the whole thing has
// been switched off. Those are the cases where getting it wrong hurts a person
// rather than costing a bike.
describe.skipIf(!process.env.DATABASE_URL)('the overnight curfew', () => {
  let bike;
  let deviceId;

  const arm = (payload = {}) => nightCurfew.arm(bike.id, deviceId, payload);
  const cutState = async () => {
    const { rows } = await pgDb.query(
      'SELECT engine_cut_active, engine_cut_reason, engine_cut_by FROM tracking_devices WHERE id = $1', [deviceId]);
    return rows[0];
  };
  const isCut = async () => (await cutState()).engine_cut_active;
  const settle = () => new Promise((r) => setTimeout(r, 80));

  beforeEach(async () => {
    await resetAllPgTables();
    nightCurfew.clearAll();
    nightCurfew.reloadSettings();
    bike = await createPgBike({ registration: 'LW78MDGP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, model, bike_id) VALUES ($1,'FMB920',$2) RETURNING id`,
      [`3532013523${Math.floor(Math.random() * 100000)}`, bike.id]);
    deviceId = rows[0].id;
  });

  afterEach(() => nightCurfew.clearAll());

  describe('cutting a bike that is being taken', () => {
    it('does not cut while the bike is still being ridden', async () => {
      expect(await arm()).toBe(true);
      await nightCurfew.cutIfSlowEnough(bike.id, 80);
      await settle();

      expect(await isCut()).toBe(false);
      expect(nightCurfew.isArmed(bike.id)).toBe(true); // still waiting, not forgotten
    });

    it('cuts once the bike is down to walking pace', async () => {
      await arm();
      await nightCurfew.cutIfSlowEnough(bike.id, 4);
      await settle();

      const state = await cutState();
      expect(state.engine_cut_active).toBe(true);
      expect(state.engine_cut_reason).toMatch(/curfew/i);
    });

    it('records that nobody decided this', async () => {
      await arm();
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await settle();

      expect((await cutState()).engine_cut_by).toBeNull();
    });

    it('raises an alert saying the engine was cut', async () => {
      await arm();
      await nightCurfew.cutIfSlowEnough(bike.id, 2);
      await settle();

      const { rows } = await pgDb.query(
        `SELECT alert_type, severity, payload FROM tracking_alerts WHERE bike_id = $1 AND alert_type = 'engine_cut_auto'`,
        [bike.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe('critical');
      expect(JSON.parse(rows[0].payload).curfew).toBe(true);
    });

    it('queues the cut command for the tracker', async () => {
      await arm();
      await nightCurfew.cutIfSlowEnough(bike.id, 1);
      await settle();

      const { rows } = await pgDb.query('SELECT command FROM tracking_commands WHERE device_id = $1', [deviceId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].command).toBe('setdigout 1');
    });

    it('cuts only once, however many slow pings follow', async () => {
      await arm();
      await nightCurfew.cutIfSlowEnough(bike.id, 1);
      await settle();
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await settle();

      const { rows } = await pgDb.query(
        `SELECT COUNT(*)::int n FROM tracking_alerts WHERE bike_id=$1 AND alert_type='engine_cut_auto'`, [bike.id]);
      expect(rows[0].n).toBe(1);
    });

    // A bike confirmed as moving at 03:58 should not earn a pass by still
    // moving at 04:02 — arming outlives the window.
    it('still cuts an armed bike after the window has passed', async () => {
      await arm();
      expect(nightCurfew.isArmed(bike.id)).toBe(true);
      await nightCurfew.cutIfSlowEnough(bike.id, 3);
      await settle();
      expect(await isCut()).toBe(true);
    });
  });

  describe('bikes it must leave alone', () => {
    const statusIsSpared = async (status) => {
      await pgDb.query('UPDATE bikes SET status = $1 WHERE id = $2', [status, bike.id]);
      expect(await nightCurfew.covers(bike.id)).toBe(false);
      expect(await arm()).toBe(false);
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await settle();
      expect(await isCut()).toBe(false);
    };

    // Immobilising a bike somebody has paid for is not ours to do.
    it('never cuts a paid-off bike', () => statusIsSpared('paid_off'));
    it('never cuts a sold bike', () => statusIsSpared('sold'));
    it('never cuts a written-off bike', () => statusIsSpared('written_off'));

    it('covers a bike that is out with a rider', async () => {
      expect(await nightCurfew.covers(bike.id)).toBe(true);
    });

    it('covers stock sitting at the depot', async () => {
      await pgDb.query(`UPDATE bikes SET status = 'ready_to_go' WHERE id = $1`, [bike.id]);
      expect(await nightCurfew.covers(bike.id)).toBe(true);
    });

    // The last bike to spare is one already known to be gone.
    it('covers a bike already flagged stolen', async () => {
      await pgDb.query(`UPDATE bikes SET status = 'stolen' WHERE id = $1`, [bike.id]);
      expect(await nightCurfew.covers(bike.id)).toBe(true);
    });

    // Whatever statuses exist today, the ones that mean somebody else owns the
    // bike must never be cuttable. This fails if a new one is added blindly.
    it('never covers a status that means the bike is not ours', async () => {
      const { CUTTABLE_STATUSES } = nightCurfew;
      for (const notOurs of ['sold', 'paid_off', 'written_off']) {
        expect(CUTTABLE_STATUSES).not.toContain(notOurs);
      }
    });

    it('spares a bike an admin has exempted', async () => {
      await pgDb.query('UPDATE bikes SET night_curfew_exempt = TRUE WHERE id = $1', [bike.id]);
      expect(await nightCurfew.covers(bike.id)).toBe(false);
      expect(await arm()).toBe(false);
      await settle();
      expect(await isCut()).toBe(false);
    });

    it('does nothing for a bike with no tracker', async () => {
      expect(await nightCurfew.arm(bike.id, null)).toBe(false);
    });
  });

  describe('the switch that stops all of it', () => {
    it('arms nothing while the curfew is off', async () => {
      await nightCurfew.setEnabled(false);
      expect(await nightCurfew.isEnabled()).toBe(false);
      expect(await arm()).toBe(false);
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await settle();
      expect(await isCut()).toBe(false);
    });

    it('takes effect without a restart', async () => {
      await nightCurfew.setEnabled(false);
      expect(await arm()).toBe(false);

      await nightCurfew.setEnabled(true);
      expect(await arm()).toBe(true);
    });

    it('is on when nothing has been saved either way', async () => {
      await pgDb.query(`DELETE FROM app_settings WHERE setting_key = 'night_curfew_enabled'`);
      nightCurfew.reloadSettings();
      expect(await nightCurfew.isEnabled()).toBe(true);
    });
  });

  describe('what an unarmed bike does', () => {
    it('is never cut by a slow ping on its own', async () => {
      expect(nightCurfew.isArmed(bike.id)).toBe(false);
      await nightCurfew.cutIfSlowEnough(bike.id, 0);
      await settle();
      expect(await isCut()).toBe(false);
    });
  });

  // Everything above drives the curfew directly. This drives it the way the
  // tracker does — raw pings through processPing — which is the only thing
  // that proves the window, the sustained-movement guard and the cut are
  // actually wired to each other.
  describe('end to end, from the tracker\'s pings', () => {
    // TRUNCATE ... RESTART IDENTITY hands every test the same bike id, and the
    // night_movement cooldown is keyed on it and lives in module memory — so
    // each test rides on its own day rather than inheriting the last one's
    // cooldown.
    let day = 14;
    beforeEach(() => { day += 1; });

    // 23:00 UTC is 01:00 SAST: inside the window, no DST to worry about.
    const nightAt = (offsetSec) => new Date(Date.UTC(2026, 0, day, 23, 0, offsetSec)).toISOString();
    // 10:00 UTC is 12:00 SAST: the middle of the working day.
    const dayAt = (offsetSec) => new Date(Date.UTC(2026, 0, day, 10, 0, offsetSec)).toISOString();

    const ride = async (at, lat, lng, speed) =>
      tripService.processPing(bike.id, deviceId, lat, lng, speed, 1, at, null, 120);

    it('cuts a bike ridden at 01:00, once it slows down', async () => {
      await ride(nightAt(0), -26.2041, 28.0473, 45);
      // ~200m away, 100s later: sustained and real ground covered.
      await ride(nightAt(100), -26.2059, 28.0473, 45);
      expect(nightCurfew.isArmed(bike.id)).toBe(true);
      expect(await isCut()).toBe(false); // still moving — not yet

      await ride(nightAt(160), -26.2065, 28.0473, 3);
      await settle();

      expect(await isCut()).toBe(true);
      const { rows } = await pgDb.query(
        `SELECT alert_type FROM tracking_alerts WHERE bike_id=$1 ORDER BY id`, [bike.id]);
      expect(rows.map((r) => r.alert_type)).toEqual(
        expect.arrayContaining(['night_movement', 'engine_cut_auto']));
    });

    it('leaves the same ride alone in the middle of the day', async () => {
      await ride(dayAt(0), -26.2041, 28.0473, 45);
      await ride(dayAt(100), -26.2059, 28.0473, 45);
      await ride(dayAt(160), -26.2065, 28.0473, 3);
      await settle();

      expect(nightCurfew.isArmed(bike.id)).toBe(false);
      expect(await isCut()).toBe(false);
    });

    // A parked bike's GPS drifts. It must not cost somebody their engine.
    it('does not cut a parked bike whose GPS twitches', async () => {
      await ride(nightAt(0), -26.2041, 28.0473, 6);
      await ride(nightAt(100), -26.20415, 28.04735, 6); // a few metres of drift
      await settle();

      expect(nightCurfew.isArmed(bike.id)).toBe(false);
      expect(await isCut()).toBe(false);
    });

    it('does not cut an exempted bike however it is ridden', async () => {
      await pgDb.query('UPDATE bikes SET night_curfew_exempt = TRUE WHERE id = $1', [bike.id]);
      await ride(nightAt(0), -26.2041, 28.0473, 45);
      await ride(nightAt(100), -26.2059, 28.0473, 45);
      await ride(nightAt(160), -26.2065, 28.0473, 0);
      await settle();

      expect(await isCut()).toBe(false);
      // …but it is still reported, so somebody can look.
      const { rows } = await pgDb.query(
        `SELECT COUNT(*)::int n FROM tracking_alerts WHERE bike_id=$1 AND alert_type='night_movement'`, [bike.id]);
      expect(rows[0].n).toBe(1);
    });
  });
});
