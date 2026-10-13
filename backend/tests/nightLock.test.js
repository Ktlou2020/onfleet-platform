import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgBike, createPgUser, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const nightLock = createRequire(import.meta.url)('../src/services/nightLock.js');
const app = buildApp();

// Locking the fleet overnight.
//
// The curfew stops a bike that is already being taken. This stops one being
// taken at all: a bike parked when the window opens cannot be started.
//
// Two things these tests care about more than the locking. Nothing here may
// ever send an immobilise to a motorcycle that might be moving — that is the
// rule the whole feature lives or dies by. And nobody may be stranded: a
// rider can let their own bike out, the control room can let anybody's out,
// and a bike still locked in daylight lets itself out.

const inWindow = new Date('2026-10-05T01:00:00Z');   // 03:00 SAST
const daylight = new Date('2026-10-05T09:00:00Z');   // 11:00 SAST

describe.skipIf(!process.env.DATABASE_URL)('the overnight fleet lock', () => {
  let bike, device, rider, control, admin;

  // ignition is an integer in gps_pings: 1 on, 0 off, null for a tracker
  // with no ignition wire. The fixture speaks the column's language.
  //
  // recorded_at is anchored to the same fake clock the sweep is handed, not
  // to the database's NOW(). Anchoring it to NOW() made the age of a fix
  // depend on what time the suite happened to run: "too old to believe" was
  // 97 minutes old at 03:23 UTC and 76 minutes old at 03:44, so the test
  // asserting a stale fix is ignored only tested anything for about an hour
  // a day and passed by luck the rest of the time.
  const ping = async (bikeId, { speed = 0, ignition = 0, minutesAgo = 5, at = inWindow } = {}) =>
    pgDb.query(
      `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, ignition, satellites, recorded_at)
       VALUES ($1, -26.1, 28.0, $2, $3, 9, $4::timestamptz - ($5 || ' minutes')::interval)`,
      [bikeId, speed, ignition, at.toISOString(), String(minutesAgo)]);

  beforeEach(async () => {
    await resetAllPgTables();
    nightLock.reloadSettings();
    await nightLock.setEnabled(true);

    admin = await createPgUser({ role: 'superadmin' });
    control = await createPgUser({ role: 'control_room' });
    rider = await createPgUser({ role: 'rider' });

    bike = await createPgBike({ registration: 'RAP001GP', status: 'active' });
    const { rows } = await pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, model, connected) VALUES ('350000000000001',$1,'FMB920',true) RETURNING id, imei`,
      [bike.id]);
    device = rows[0];
    await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
  });

  const commandCount = async () => {
    const { rows } = await pgDb.query(
      'SELECT COUNT(*)::int AS n FROM tracking_commands WHERE device_id = $1', [device.id]);
    return rows[0].n;
  };

  const lockState = async () => {
    const { rows } = await pgDb.query('SELECT night_lock_active FROM tracking_devices WHERE id = $1', [device.id]);
    return rows[0].night_lock_active;
  };

  describe('the midnight sweep', () => {
    it('locks a bike that is standing still', async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      const res = await nightLock.lockAll({ at: inWindow });
      expect(res.locked).toBe(1);
      expect(await lockState()).toBe(true);
    });

    // The rule the whole feature lives or dies by.
    it('never touches one that is moving', async () => {
      await ping(bike.id, { speed: 45, ignition: 1 });
      const res = await nightLock.lockAll({ at: inWindow });
      expect(res.locked, 'an immobilise was sent to a moving motorcycle').toBe(0);
      expect(await lockState()).toBe(false);
    });

    it('nor one whose ignition is on at a standstill', async () => {
      await ping(bike.id, { speed: 0, ignition: 1 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState(), 'a bike idling with somebody on it was locked').toBe(false);
    });

    // A tracker that has not spoken for hours might be anywhere.
    it('nor one whose last fix is too old to believe', async () => {
      await ping(bike.id, { speed: 0, ignition: 0, minutesAgo: 240 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);
    });

    it('nor one that has never reported at all', async () => {
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);
    });

    // A bike stopped by a person stays stopped by that person, and the
    // morning sweep must not wake it.
    it('nor one already cut for another reason', async () => {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active = TRUE, engine_cut_reason = 'Stolen' WHERE id = $1`, [device.id]);
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);
    });

    it('nor an exempt bike', async () => {
      await pgDb.query('UPDATE bikes SET night_curfew_exempt = TRUE WHERE id = $1', [bike.id]);
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);
    });

    it('nor a bike somebody already let out tonight', async () => {
      await pgDb.query(
        `UPDATE bikes SET night_lock_released_until = NOW() + interval '2 hours' WHERE id = $1`, [bike.id]);
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);
    });

    // A deployment should not start immobilising a fleet because it was
    // deployed.
    it('and does nothing at all until it is switched on', async () => {
      await nightLock.setEnabled(false);
      await ping(bike.id, { speed: 0, ignition: 0 });
      const res = await nightLock.lockAll({ at: inWindow });
      expect(res).toMatchObject({ locked: 0, reason: 'disabled' });
    });
  });

  describe('the morning sweep', () => {
    beforeEach(async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
    });

    it('wakes everything it put to sleep', async () => {
      const res = await nightLock.unlockAll();
      expect(res).toMatchObject({ unlocked: 1, attempted: 1 });
      expect(await lockState()).toBe(false);
    });

    // Watching the flag is not enough: releasing also sends a restore to the
    // tracker. A sweep that touched every device would physically start a
    // stolen bike working again and leave the flag set, which reads as
    // correct in the database and is a bike on the road in Johannesburg.
    it('and sends nothing at all to a bike cut for theft', async () => {
      const other = await createPgBike({ registration: 'RAP002GP', status: 'active' });
      const { rows } = await pgDb.query(
        `INSERT INTO tracking_devices (imei, bike_id, model, engine_cut_active, engine_cut_reason)
         VALUES ('350000000000002',$1,'FMB920',TRUE,'Stolen') RETURNING id`, [other.id]);
      const stolen = rows[0].id;

      await nightLock.unlockAll();

      const { rows: commands } = await pgDb.query(
        'SELECT command FROM tracking_commands WHERE device_id = $1', [stolen]);
      expect(commands, 'the morning sweep sent a command to a stolen bike').toEqual([]);

      const { rows: after } = await pgDb.query(
        'SELECT engine_cut_active FROM tracking_devices WHERE id = $1', [stolen]);
      expect(after[0].engine_cut_active).toBe(true);
    });
  });

  // The failure that would keep a fleet off the road: the four o'clock sweep
  // did not run. The bike itself is the backstop.
  describe('a bike still locked in daylight', () => {
    it('releases itself on its own report', async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });

      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: false, at: daylight, now: daylight,
      });
      expect(outcome).toBe('self_released');
      expect(await lockState()).toBe(false);
    });
  });

  describe('a locked bike that somebody has started', () => {
    beforeEach(async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
    });

    it('is locked again while it is standing still', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: true, at: inWindow, now: inWindow,
      });
      expect(outcome).toBe('reasserted');
    });

    // The back door into cutting at speed, closed.
    it('but never while it is moving', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 55, ignitionOn: true, at: inWindow, now: inWindow,
      });
      expect(outcome, 'an immobilise was re-sent to a bike doing 55').toBeNull();
    });

    it('nor on a fix we cannot measure the speed of', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: null, ignitionOn: true, at: inWindow, now: inWindow,
      });
      expect(outcome).toBeNull();
    });
  });

  // The night this shipped, six bikes were locked at midnight and released
  // within the hour, each logged as "still locked after the window" at around
  // half past twelve. The cause was not the window, the sweep, or the
  // trackers: a Teltonika unit that sleeps or loses coverage buffers its
  // records and dumps them oldest-first when it dials in, and the hook was
  // reading the clock off whichever record it had been handed. A fix stamped
  // 23:34, arriving at 00:35, said "outside the window" and let the bike go.
  //
  // Which is why the lock appeared to work on some bikes and not others. The
  // bikes it failed on were the ones that reported during the night.
  describe('a tracker dialling in with a backlog', () => {
    // 00:00 SAST, the sweep. 00:35 SAST, the device wakes and uploads the
    // hour it slept through: a record stamped 23:34, then one stamped 00:34.
    const sweptAt = new Date('2026-10-04T22:00:00Z');
    const dialsInAt = new Date('2026-10-04T22:35:27Z');
    const staleRecord = new Date('2026-10-04T21:34:53Z');
    const liveRecord = new Date('2026-10-04T22:34:53Z');

    beforeEach(async () => {
      await ping(bike.id, { speed: 0, ignition: 0, at: sweptAt });
      const res = await nightLock.lockAll({ at: sweptAt });
      expect(res.locked, 'the fixture did not lock the bike').toBe(1);
    });

    it('stays locked when the backlog arrives', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: false,
        at: staleRecord, now: dialsInAt,
      });
      expect(outcome, 'an hour-old record released a bike mid-window').toBeNull();
      expect(await lockState()).toBe(true);
    });

    it('and through the whole batch, oldest first', async () => {
      for (const at of [staleRecord, liveRecord]) {
        await nightLock.onPosition({
          deviceId: device.id, speedKmh: 0, ignitionOn: false, at, now: dialsInAt,
        });
      }
      expect(await lockState(), 'the bike was let out by its own backlog').toBe(true);
    });

    // The release is still unconditional in daylight. That backstop is the
    // reason a failed morning sweep cannot keep a fleet off the road, and
    // nothing here is allowed to weaken it.
    it('but a backlog arriving in daylight still releases the bike', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: false,
        at: staleRecord, now: daylight,
      });
      expect(outcome).toBe('self_released');
      expect(await lockState()).toBe(false);
    });

    // Rule 1, by way of the backlog. A bike parked at 23:34 and ridden at
    // 00:35 uploads "speed 0" with an old timestamp; believing it would put
    // an immobilise into a moving motorcycle.
    it('never re-cuts on an hour-old standstill', async () => {
      const before = await commandCount();
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: true,
        at: staleRecord, now: dialsInAt,
      });
      expect(outcome, 'a cut was decided from an hour-old reading').toBeNull();
      expect(await commandCount()).toBe(before);
    });

    it('and not on one stamped in the future either', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 0, ignitionOn: true,
        at: new Date(dialsInAt.getTime() + 6 * 3600 * 1000), now: dialsInAt,
      });
      expect(outcome).toBeNull();
    });
  });

  // The other half of the same night: of 64 bikes eligible at midnight, 11
  // got no command at all, because they were asleep or out of coverage when
  // the sweep ran and nothing ran again. lockAll's own documentation had been
  // promising for months that such a bike would be "picked up the moment it
  // reports in". This is that promise, finally kept.
  describe('a bike the midnight sweep could not reach', () => {
    const dialsInAt = new Date('2026-10-04T23:00:00Z');   // 01:00 SAST
    const liveRecord = new Date('2026-10-04T22:59:30Z');

    const report = (over = {}) => nightLock.onPosition({
      deviceId: device.id, speedKmh: 0, ignitionOn: false,
      at: liveRecord, now: dialsInAt, ...over,
    });

    it('is locked on its first report inside the window', async () => {
      expect(await lockState(), 'the fixture started out locked').toBe(false);
      expect(await report()).toBe('late_locked');
      expect(await lockState()).toBe(true);
    });

    it('and the cut is actually sent', async () => {
      await report();
      const { rows } = await pgDb.query(
        'SELECT command FROM tracking_commands WHERE device_id = $1', [device.id]);
      expect(rows.map((r) => r.command)).toEqual(['setdigout 1']);
    });

    // Rule 1 again, on the new path.
    it('but never one that is moving', async () => {
      expect(await report({ speedKmh: 55 }), 'an immobilise was sent to a bike doing 55').toBeNull();
      expect(await lockState()).toBe(false);
    });

    it('nor one whose ignition is on at a standstill', async () => {
      expect(await report({ ignitionOn: true })).toBeNull();
      expect(await lockState()).toBe(false);
    });

    // Unknown is not still. A report whose speed we were not given could be
    // a bike at a robot or a bike at eighty.
    it('nor one whose speed we cannot measure', async () => {
      expect(await report({ speedKmh: null })).toBeNull();
      expect(await lockState()).toBe(false);
    });

    it('nor on a record out of the backlog', async () => {
      const stale = new Date(dialsInAt.getTime() - 61 * 60 * 1000);
      expect(await report({ at: stale })).toBeNull();
      expect(await lockState()).toBe(false);
    });

    it('and nothing at all outside the window', async () => {
      expect(await report({ now: daylight, at: daylight })).toBeNull();
      expect(await lockState()).toBe(false);
    });

    it('nor while the lock is switched off', async () => {
      await nightLock.setEnabled(false);
      expect(await report(), 'a bike was locked with the feature off').toBeNull();
      expect(await lockState()).toBe(false);
    });

    // Somebody else's cut is somebody else's decision, and the morning sweep
    // must not restore it.
    it('nor a bike already cut for theft or arrears', async () => {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active = TRUE, engine_cut_reason = 'stolen' WHERE id = $1`,
        [device.id]);
      expect(await report()).toBeNull();
      expect(await lockState(), 'the night lock took over a theft cut').toBe(false);
    });

    it('nor one the curfew does not cover', async () => {
      await pgDb.query('UPDATE bikes SET night_curfew_exempt = TRUE WHERE id = $1', [bike.id]);
      expect(await report()).toBeNull();
      expect(await lockState()).toBe(false);
    });

    // A rider who let their bike out at midnight does not get locked again
    // at one by the same feature.
    it('nor one a rider has already let out tonight', async () => {
      await pgDb.query(
        `UPDATE bikes SET night_lock_released_until = $1 WHERE id = $2`,
        [new Date('2026-10-05T02:00:00Z'), bike.id]);
      expect(await report(), 'a released bike was locked again an hour later').toBeNull();
      expect(await lockState()).toBe(false);
    });

    // Two records from one batch, in flight at the same time: one cut, not
    // two.
    //
    // What this actually demonstrates is the flag short-circuiting the second
    // record, because the test pool serialises the queries and the first
    // call's UPDATE always lands before the second call's SELECT. The
    // `night_lock_active = FALSE` on that UPDATE is for the case this harness
    // cannot stage — two records genuinely in flight against a multi-client
    // pool, both having read the row as unlocked. Removing it does not fail
    // this test. It is kept because it is free and because the alternative is
    // a second immobilise sent to the same motorcycle.
    it('is locked once, however many records arrive together', async () => {
      const outcomes = await Promise.all([
        report(),
        report({ at: new Date(dialsInAt.getTime() - 1000) }),
      ]);
      expect(outcomes.filter((o) => o === 'late_locked'),
        'two records both decided to lock the same bike').toHaveLength(1);
      expect(await commandCount(), 'the same bike was cut twice').toBe(1);
    });
  });

  describe('the ways out', () => {
    beforeEach(async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
    });

    // The one that matters: a rider finishing a late shift, at one in the
    // morning, who should not have to phone anybody.
    it('a rider lets their own bike out from the app', async () => {
      const res = await request(app).post('/api/tracking/night-lock/release').set(authHeader(rider.user));
      expect(res.status).toBe(200);
      expect(res.body.registration).toBe('RAP001GP');
      expect(await lockState()).toBe(false);
    });

    it('and it stays out for the rest of the night', async () => {
      await request(app).post('/api/tracking/night-lock/release').set(authHeader(rider.user));
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState(), 'the next sweep locked a bike somebody had just released').toBe(false);
    });

    it('the app can ask whether it is locked', async () => {
      const res = await request(app).get('/api/tracking/night-lock/mine').set(authHeader(rider.user));
      expect(res.body).toMatchObject({ night_locked: true, stopped_for_another_reason: false });
      expect(res.body.bike.registration).toBe('RAP001GP');
    });

    it('a rider cannot release somebody else\'s bike', async () => {
      const other = await createPgUser({ role: 'rider' });
      const res = await request(app).post('/api/tracking/night-lock/release').set(authHeader(other.user));
      expect(res.status).toBe(404);
      expect(await lockState()).toBe(true);
    });

    it('the control room can release anybody\'s', async () => {
      const res = await request(app).post(`/api/tracking/night-lock/${bike.id}/release`)
        .set(authHeader(control.user)).send({ reason: 'Rider phoned, phone flat' });
      expect(res.status).toBe(200);
      expect(await lockState()).toBe(false);
    });

    it('and can see what is locked tonight', async () => {
      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(control.user));
      expect(res.body.count).toBe(1);
      expect(res.body.locked[0]).toMatchObject({ registration: 'RAP001GP', rider_name: rider.user.full_name });
    });

    // The release is for the overnight lock and nothing else. A bike stopped
    // for theft or arrears was stopped by a person's decision.
    it('but neither can release an engine cut', async () => {
      await pgDb.query(
        `UPDATE tracking_devices SET engine_cut_active = TRUE, engine_cut_reason = 'Stolen' WHERE id = $1`, [device.id]);

      const byRider = await request(app).post('/api/tracking/night-lock/release').set(authHeader(rider.user));
      expect(byRider.status).toBe(409);
      expect(byRider.body.code).toBe('NOT_A_NIGHT_LOCK');

      const byControl = await request(app).post(`/api/tracking/night-lock/${bike.id}/release`)
        .set(authHeader(control.user)).send({});
      expect(byControl.status).toBe(409);

      const { rows } = await pgDb.query('SELECT engine_cut_active FROM tracking_devices WHERE id = $1', [device.id]);
      expect(rows[0].engine_cut_active, 'a stolen bike was released by the night-lock door').toBe(true);
    });

    it('and a release is on the audit trail', async () => {
      await request(app).post('/api/tracking/night-lock/release').set(authHeader(rider.user));
      const { rows } = await pgDb.query(
        `SELECT action FROM audit_logs WHERE action = 'night_lock.released_by_rider'`);
      expect(rows).toHaveLength(1);
    });
  });

  // The two screens built on top of all this: the control room's list of
  // locked bikes, and the admin switch that decides whether anything is
  // locked at all.
  describe('the board the control room works from', () => {
    beforeEach(async () => {
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
    });

    it('moves a released bike out of the locked list and onto the pass list', async () => {
      await request(app).post(`/api/tracking/night-lock/${bike.id}/release`)
        .set(authHeader(control.user)).send({ reason: 'Late shift' });

      // release() writes a pass that runs to 04:00 SAST, so whether it is
      // still live depends on when the suite happens to run. The board only
      // ever shows live passes — correct in the small hours, where releases
      // actually happen — so put the clock where a real release would be.
      await pgDb.query(
        `UPDATE bikes SET night_lock_released_until = NOW() + interval '1 hour' WHERE id = $1`, [bike.id]);

      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(control.user));
      expect(res.body.count).toBe(0);
      expect(res.body.released_count).toBe(1);
      expect(res.body.released[0]).toMatchObject({ registration: 'RAP001GP', rider_name: rider.user.full_name });
      // Without this the screen cannot tell anybody how long the pass lasts.
      expect(res.body.released[0].night_lock_released_until).toBeTruthy();
    });

    it('and drops a spent pass off the board once the night is over', async () => {
      await request(app).post(`/api/tracking/night-lock/${bike.id}/release`)
        .set(authHeader(control.user)).send({});
      await pgDb.query(
        `UPDATE bikes SET night_lock_released_until = NOW() - interval '1 hour' WHERE id = $1`, [bike.id]);

      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(control.user));
      expect(res.body.released_count, 'last night\'s passes were still on the board').toBe(0);
    });

    it('says whether the lock is on and when the window runs', async () => {
      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(control.user));
      expect(res.body.enabled).toBe(true);
      expect(res.body.window).toMatchObject({ start_hour: 0, end_hour: 4 });
      expect(typeof res.body.in_window).toBe('boolean');
    });

    // The lock borrows the curfew's rule for which bikes it may touch, and
    // that rule fails closed. Switched on with the curfew off it locks
    // nothing, so the board has to be able to say so.
    it('says when it is switched on but the curfew leaves it doing nothing', async () => {
      const nightCurfew = createRequire(import.meta.url)('../src/services/nightCurfew.js');
      await nightCurfew.setEnabled(false);
      nightCurfew.reloadSettings();

      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(control.user));
      expect(res.body.enabled).toBe(true);
      expect(res.body.curfew_enabled, 'the board would have read "armed" over a fleet nothing can lock').toBe(false);

      // And it really does lock nothing, which is the thing the board is warning about.
      await pgDb.query('UPDATE tracking_devices SET night_lock_active = FALSE');
      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(false);

      await nightCurfew.setEnabled(true);
      nightCurfew.reloadSettings();
    });

    it('a rider cannot read the board', async () => {
      const res = await request(app).get('/api/tracking/night-lock').set(authHeader(rider.user));
      expect(res.status).toBe(403);
    });
  });

  describe('the switch', () => {
    it('an admin turns the lock off and nothing is locked that night', async () => {
      const off = await request(app).put('/api/tracking/night-lock')
        .set(authHeader(admin.user)).send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);

      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState(), 'the sweep locked a bike after the feature was switched off').toBe(false);
    });

    it('and turns it back on', async () => {
      await request(app).put('/api/tracking/night-lock').set(authHeader(admin.user)).send({ enabled: false });
      await request(app).put('/api/tracking/night-lock').set(authHeader(admin.user)).send({ enabled: true });

      await ping(bike.id, { speed: 0, ignition: 0 });
      await nightLock.lockAll({ at: inWindow });
      expect(await lockState()).toBe(true);
    });

    // The control room may let one bike out. Deciding the fleet is not locked
    // tonight is a different decision and not theirs.
    it('the control room cannot touch it', async () => {
      const res = await request(app).put('/api/tracking/night-lock')
        .set(authHeader(control.user)).send({ enabled: false });
      expect(res.status).toBe(403);
      expect(await nightLock.isEnabled(), 'the control room switched the whole feature off').toBe(true);
    });

    it('and the change is on the audit trail', async () => {
      await request(app).put('/api/tracking/night-lock').set(authHeader(admin.user)).send({ enabled: false });
      const { rows } = await pgDb.query(
        `SELECT action FROM audit_logs WHERE action = 'night_lock.disabled'`);
      expect(rows).toHaveLength(1);
    });
  });

  // Restoring by hand is somebody deciding this bike may run.
  it('restoring an engine by hand clears the lock too', async () => {
    await ping(bike.id, { speed: 0, ignition: 0 });
    await nightLock.lockAll({ at: inWindow });
    await request(app).post(`/api/tracking/devices/${device.id}/commands`)
      .set(authHeader(admin.user)).send({ preset: 'restore_engine' });
    expect(await lockState(), 'the next sweep would have put it back to sleep').toBe(false);
  });
});
