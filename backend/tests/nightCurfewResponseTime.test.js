import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike, createPgUser } from './helpers/testPgDb.js';

const require_ = createRequire(import.meta.url);

// A 50ms poll so the interval can be watched with real timers. Fake ones do
// not help here: each tick writes a command row, and that is real I/O a fake
// clock will not wait for.
process.env.NIGHT_CURFEW_POLL_SEC = '0.05';
process.env.NIGHT_CURFEW_POLL_MINUTES = '0.005'; // 300ms ceiling
const nightCurfew = require_('../src/services/nightCurfew.js');
const teltonika = require_('../src/tcp/teltonikaServer.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How long a stolen bike keeps running.
//
// Everything in the curfew happens when a position arrives, and until now
// nothing asked for one. A tracker left on its own schedule reports every
// minute or two while moving, so the sequence was: the thief slows at a
// robot, the bike is cuttable for those few seconds, and the platform does
// not find out until the next scheduled report — by which time they are
// moving again and the cut waits for the next stop.
//
// These are about the two things that shortened it: asking the device where
// it is while a cut is pending, and treating a switched-off ignition as safe
// to cut rather than waiting for a slow speed reading that will never come.

describe.skipIf(!process.env.DATABASE_URL)('how quickly an armed bike is stopped', () => {
  let bike, device;

  beforeEach(async () => {
    await resetAllPgTables();
    nightCurfew.clearAll();
    await createPgUser({ role: 'superadmin' });
    bike = await createPgBike({ registration: 'RAP001GP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model, connected) VALUES ('350000000000001',$1,'FMB920',true) RETURNING id, imei`,
      [bike.id]);
    device = rows[0];
  });

  afterEach(() => {
    nightCurfew.clearAll();
    vi.restoreAllMocks();
  });

  // The original rule, unchanged: the engine never dies under somebody at
  // speed, whatever else is true.
  it('still refuses to cut a bike that is being ridden', async () => {
    await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
    const cut = await nightCurfew.cutIfSlowEnough(bike.id, 80);
    expect(cut).toBe(false);
    expect(nightCurfew.isArmed(bike.id), 'the cut was thrown away rather than kept waiting').toBe(true);
  });

  it('and cuts it at walking pace, as it always did', async () => {
    await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
    expect(await nightCurfew.cutIfSlowEnough(bike.id, 3)).toBe(true);
    const { rows } = await pgDb.query('SELECT engine_cut_active FROM tracking_devices WHERE id = $1', [device.id]);
    expect(rows[0].engine_cut_active).toBe(true);
  });

  describe('a bike that has been switched off', () => {
    // The case that used to wait forever. A thief parks it somewhere to
    // collect later; the ignition goes off; no slow *speed* reading is ever
    // going to arrive, because the bike is not moving and the last thing it
    // reported was a road speed.
    it('is cut without waiting for a slow speed reading', async () => {
      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      const cut = await nightCurfew.cutIfSlowEnough(bike.id, 60, { ignitionOn: false });
      expect(cut, 'a parked bike with the engine off was left running').toBe(true);
    });

    it('and the alert says that is why', async () => {
      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      await nightCurfew.cutIfSlowEnough(bike.id, 60, { ignitionOn: false });
      const { rows } = await pgDb.query(
        `SELECT payload FROM tracking_alerts WHERE alert_type = 'engine_cut_auto'`);
      const payload = JSON.parse(rows[0].payload);
      expect(payload.cut_on_ignition_off).toBe(true);
      expect(payload.waited_ms, 'the number this whole mechanism is judged by').toBeGreaterThanOrEqual(0);
    });

    // A tracker with no ignition wire reports nothing either way, and must not
    // be treated as switched off — that would cut a moving bike.
    it('but a tracker with no ignition signal decides on speed alone', async () => {
      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      const cut = await nightCurfew.cutIfSlowEnough(bike.id, 60, { ignitionOn: null });
      expect(cut, 'a bike doing 60 was cut on a guess').toBe(false);
    });

    it('and an ignition that is on is no reason to cut at speed either', async () => {
      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      expect(await nightCurfew.cutIfSlowEnough(bike.id, 60, { ignitionOn: true })).toBe(false);
    });
  });

  describe('asking the device where it is', () => {
    it('starts asking as soon as the cut is armed', async () => {
      vi.spyOn(teltonika, 'getConnectedIMEIs').mockReturnValue([device.imei]);
      const send = vi.spyOn(teltonika, 'sendCommand').mockReturnValue(true);

      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      await wait(nightCurfew.POLL_INTERVAL_MS + 50);
      await wait(nightCurfew.POLL_INTERVAL_MS + 50);

      // Twice in two intervals: the point is that it does not sit waiting for
      // the tracker's own schedule.
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(send.mock.calls[0][2]).toBe('getgps');
    });

    it('and stops the moment the bike is cut', async () => {
      vi.spyOn(teltonika, 'getConnectedIMEIs').mockReturnValue([device.imei]);
      const send = vi.spyOn(teltonika, 'sendCommand').mockReturnValue(true);

      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      await wait(nightCurfew.POLL_INTERVAL_MS + 50);
      await nightCurfew.cutIfSlowEnough(bike.id, 2);
      const afterCut = send.mock.calls.length;
      await wait(nightCurfew.POLL_INTERVAL_MS * 3);

      expect(send.mock.calls.length, 'it kept asking a bike that was already stopped').toBe(afterCut);
    });

    it('and when the cut is called off', async () => {
      vi.spyOn(teltonika, 'getConnectedIMEIs').mockReturnValue([device.imei]);
      const send = vi.spyOn(teltonika, 'sendCommand').mockReturnValue(true);

      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      nightCurfew.disarm(bike.id);
      await wait(nightCurfew.POLL_INTERVAL_MS * 3);

      expect(send.mock.calls.length, 'a disarmed bike was still being polled').toBe(0);
    });

    // Asking a tracker that is not dialled in achieves nothing and costs a
    // queued command that arrives whenever it next connects — which is the
    // delay this exists to remove.
    it('does not ask a device that is not connected', async () => {
      vi.spyOn(teltonika, 'getConnectedIMEIs').mockReturnValue([]);
      const send = vi.spyOn(teltonika, 'sendCommand').mockReturnValue(true);

      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      await wait(nightCurfew.POLL_INTERVAL_MS * 2 + 100);

      expect(send).not.toHaveBeenCalled();
    });

    // A poll that cannot stop is a bill nobody authorised.
    it('gives up after the ceiling rather than asking forever', async () => {
      vi.spyOn(teltonika, 'getConnectedIMEIs').mockReturnValue([device.imei]);
      const send = vi.spyOn(teltonika, 'sendCommand').mockReturnValue(true);

      await nightCurfew.arm(bike.id, device.id, {}, { at: new Date('2026-10-03T01:00:00Z') });
      await wait(nightCurfew.POLL_CEILING_MS + nightCurfew.POLL_INTERVAL_MS * 3);
      const atCeiling = send.mock.calls.length;
      await wait(nightCurfew.POLL_INTERVAL_MS * 5);

      expect(send.mock.calls.length).toBe(atCeiling);
      // The cut is still pending — giving up on asking is not giving up on
      // cutting. The next position that arrives on its own still stops it.
      expect(nightCurfew.isArmed(bike.id)).toBe(true);
    });
  });
});
