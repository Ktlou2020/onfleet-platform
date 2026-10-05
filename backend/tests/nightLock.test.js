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
        deviceId: device.id, speedKmh: 0, ignitionOn: false, at: daylight,
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
        deviceId: device.id, speedKmh: 0, ignitionOn: true, at: inWindow,
      });
      expect(outcome).toBe('reasserted');
    });

    // The back door into cutting at speed, closed.
    it('but never while it is moving', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: 55, ignitionOn: true, at: inWindow,
      });
      expect(outcome, 'an immobilise was re-sent to a bike doing 55').toBeNull();
    });

    it('nor on a fix we cannot measure the speed of', async () => {
      const outcome = await nightLock.onPosition({
        deviceId: device.id, speedKmh: null, ignitionOn: true, at: inWindow,
      });
      expect(outcome).toBeNull();
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
