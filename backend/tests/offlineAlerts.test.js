import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const trips = createRequire(import.meta.url)('../src/services/tripService.js');

// Telling somebody a tracker is broken is a different statement from marking it
// disconnected, and the two used to be made in the same breath, fifteen minutes
// after the last ping. These units connect, push and drop the link, so a bike in
// a basement crossed that line every day and was back before anyone opened the
// alert. The flag still turns over in a quarter of an hour; the alert waits six
// hours.

const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString();

async function addDevice({ imei, lastSeenAt, bikeId, connected = true }) {
  const { rows } = await pgDb.query(
    `INSERT INTO tracking_devices (imei, bike_id, connected, last_seen_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [imei, bikeId, connected, lastSeenAt]);
  return rows[0].id;
}

const offlineAlerts = async (deviceId) => {
  const { rows } = await pgDb.query(
    `SELECT id FROM tracking_alerts WHERE device_id = $1 AND alert_type = 'device_offline' ORDER BY id`,
    [deviceId]);
  return rows;
};

describe.skipIf(!process.env.DATABASE_URL)('a tracker that goes quiet', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    trips.__resetForTests();
    bike = await createPgBike();
  });

  it('is not reported after twenty minutes', async () => {
    const id = await addDevice({ imei: 'off-20m', lastSeenAt: hoursAgo(1 / 3), bikeId: bike.id });
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(0);
  });

  it('is not reported an hour before the six-hour mark', async () => {
    const id = await addDevice({ imei: 'off-5h', lastSeenAt: hoursAgo(5), bikeId: bike.id });
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(0);
  });

  it('is reported once it has been quiet for seven hours', async () => {
    const id = await addDevice({ imei: 'off-7h', lastSeenAt: hoursAgo(7), bikeId: bike.id });
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(1);
  });

  // The sweep runs every five minutes. Without a guard tied to the device's own
  // last ping, a tracker that has been dead for a week would raise a fresh alert
  // on every cooldown expiry.
  it('is reported once, not on every sweep', async () => {
    const id = await addDevice({ imei: 'off-repeat', lastSeenAt: hoursAgo(30), bikeId: bike.id });
    await trips.checkOfflineDevices();
    await trips.checkOfflineDevices();
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(1);
  });

  // ...and the guard is the device's last ping, not a timer, so it survives the
  // process restarting — which the in-memory cooldown does not.
  it('is reported again after it comes back and goes quiet a second time', async () => {
    const id = await addDevice({ imei: 'off-twice', lastSeenAt: hoursAgo(30), bikeId: bike.id });
    await trips.checkOfflineDevices();

    // Two days in the life of one tracker, laid out on a real clock. It went
    // quiet 30 hours ago and was reported 24 hours ago; the sweep above stands
    // in for that, so its alert is dated back to when it would have been
    // raised. The tracker then reported again 8 hours ago and has been silent
    // since — a second episode, past six hours, and nobody has been told.
    await pgDb.query(
      `UPDATE tracking_alerts SET created_at = $2 WHERE device_id = $1 AND alert_type = 'device_offline'`,
      [id, hoursAgo(24)]);
    await pgDb.query(`UPDATE tracking_devices SET last_seen_at = $2, connected = TRUE WHERE id = $1`,
      [id, hoursAgo(8)]);
    trips.__resetForTests(); // the four-hour in-memory cooldown is not what is under test
    await trips.checkOfflineDevices();

    expect(await offlineAlerts(id)).toHaveLength(2);
  });

  // The other half of that rule: an alert raised after the last ping means this
  // silence has already been reported, however old the alert is.
  it('is not reported twice for one long silence, however stale the alert', async () => {
    const id = await addDevice({ imei: 'off-one-episode', lastSeenAt: hoursAgo(72), bikeId: bike.id });
    await trips.checkOfflineDevices();
    await pgDb.query(
      `UPDATE tracking_alerts SET created_at = $2 WHERE device_id = $1 AND alert_type = 'device_offline'`,
      [id, hoursAgo(66)]);
    trips.__resetForTests();
    await trips.checkOfflineDevices();

    expect(await offlineAlerts(id)).toHaveLength(1);
  });

  it('says nothing about a device with no bike on it', async () => {
    const id = await addDevice({ imei: 'off-nobike', lastSeenAt: hoursAgo(30), bikeId: null });
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(0);
  });

  it('says nothing about a device that has never reported at all', async () => {
    const id = await addDevice({ imei: 'off-never', lastSeenAt: null, bikeId: bike.id, connected: false });
    await trips.checkOfflineDevices();
    expect(await offlineAlerts(id)).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the connected flag keeps its own clock', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    trips.__resetForTests();
    bike = await createPgBike();
  });

  const connectedOf = async (id) =>
    (await pgDb.query(`SELECT connected FROM tracking_devices WHERE id = $1`, [id])).rows[0].connected;

  // The map must stop drawing a bike as live long before its silence means
  // anything, so this threshold stays where it was.
  it('turns over a quarter of an hour after the last ping, long before any alert', async () => {
    const id = await addDevice({ imei: 'flag-20m', lastSeenAt: hoursAgo(1 / 3), bikeId: bike.id });
    await trips.checkOfflineDevices();
    expect(await connectedOf(id)).toBe(false);
    expect(await offlineAlerts(id)).toHaveLength(0);
  });

  it('leaves a device that pinged a minute ago alone', async () => {
    const id = await addDevice({ imei: 'flag-1m', lastSeenAt: hoursAgo(1 / 60), bikeId: bike.id });
    await trips.checkOfflineDevices();
    expect(await connectedOf(id)).toBe(true);
  });
});
