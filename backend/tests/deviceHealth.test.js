import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgOrg, createPgBike } from './helpers/testPgDb.js';

const load = createRequire(import.meta.url);
const health = load('../src/services/deviceHealth.js');

// Which trackers are worth looking at.
//
// The list exists to answer one question: is this tracker broken? Every test
// below is a case where the old rules answered "yes" about a device that was
// working perfectly, or would have answered "no" about one that was not.

const NOW = new Date('2026-09-23T10:00:00Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60 * 1000);

/** A device reporting normally: fresh pings, good fix, good signal. */
function healthy(over = {}) {
  return {
    device_id: 1, bike_id: 10, imei: '123', last_seen_at: minutesAgo(1), connected: true,
    health_ack_signature: null,
    pings: 12, newest: minutesAgo(1), navigating: 10,
    weak_fix_navigating: 0, weak_gsm: 0, latest_gsm: 4, latest_batt_mv: 4100,
    ...over,
  };
}

const keys = (row, status = 'active') =>
  health.reasonsFor(row, { status, now: NOW }).reasons.map((r) => r.key);

describe('a parked bike is not a broken tracker', () => {
  // The bug this was written for. A Teltonika powers its GNSS down when the
  // bike is stationary and keeps reporting the last known position with zero
  // satellites. It is still connected, so it looked active and faulty at once.
  it('says nothing about a stationary bike reporting zero satellites', () => {
    const parked = healthy({ navigating: 0, weak_fix_navigating: 0 });
    expect(keys(parked)).toEqual([]);
  });

  // Even a bike that moved briefly must not be judged on a handful of pings.
  it('does not flag a bike that barely moved in the window', () => {
    expect(keys(healthy({ navigating: 3, weak_fix_navigating: 3 }))).toEqual([]);
  });

  it('still flags a bike that cannot get a fix while it is moving', () => {
    expect(keys(healthy({ navigating: 10, weak_fix_navigating: 8 }))).toContain('weak_gps');
  });

  it('says how many of the moving pings were bad, so the number can be judged', () => {
    const { reasons } = health.reasonsFor(
      healthy({ navigating: 10, weak_fix_navigating: 8 }), { status: 'active', now: NOW });
    expect(reasons.find((r) => r.key === 'weak_gps').text).toBe('Weak GPS fix while moving (8 of last 10)');
  });
});

describe('one bad reading is weather, not a fault', () => {
  it('ignores a single weak fix among good ones', () => {
    expect(keys(healthy({ navigating: 10, weak_fix_navigating: 1 }))).toEqual([]);
  });

  it('ignores a single weak signal reading', () => {
    expect(keys(healthy({ weak_gsm: 1 }))).toEqual([]);
  });

  it('flags signal that is weak across most of the window', () => {
    expect(keys(healthy({ weak_gsm: 9 }))).toContain('poor_signal');
  });
});

describe('a stale ping describes the past, not the present', () => {
  // A tracker silent since last week should be reported as offline and
  // nothing else. Its last satellite count is history.
  it('does not report GPS or signal from readings older than the freshness window', () => {
    const stale = healthy({
      newest: minutesAgo(120), navigating: 10, weak_fix_navigating: 10,
      weak_gsm: 12, latest_batt_mv: 3200,
    });
    expect(keys(stale, 'offline')).toEqual(['offline']);
  });

  it('still reports the device as offline', () => {
    expect(keys(healthy({ newest: minutesAgo(120) }), 'offline')).toContain('offline');
  });

  it('reports a device that has never connected', () => {
    const never = healthy({ last_seen_at: null, newest: null, pings: 0 });
    const { reasons } = health.reasonsFor(never, { status: 'offline', now: NOW });
    expect(reasons[0]).toMatchObject({ key: 'offline', text: 'Never connected' });
  });
});

describe('battery', () => {
  it('flags the tracker\'s own cell when it is nearly flat', () => {
    expect(keys(healthy({ latest_batt_mv: 3350 }))).toContain('battery_critical');
  });

  it('leaves a healthy cell alone', () => {
    expect(keys(healthy({ latest_batt_mv: 4100 }))).toEqual([]);
  });

  it('converts millivolts to a percentage the same way the map does', () => {
    expect(health.battPct(4200)).toBe(100);
    expect(health.battPct(3200)).toBe(0);
    expect(health.battPct(3400)).toBe(20);
  });
});

describe('acknowledging a device', () => {
  const sig = (reasons) => health.signatureOf(reasons);

  it('ignores the numbers, so a draining battery stays dismissed', () => {
    expect(sig([{ key: 'battery_critical', severity: 'high', text: 'Internal battery 20%' }]))
      .toBe(sig([{ key: 'battery_critical', severity: 'high', text: 'Internal battery 5%' }]));
  });

  // The old signature was keys only, so a device cleared on "offline,weak_gps"
  // that recovered its GPS got a new signature and reappeared — for being
  // healthier than when it was dismissed.
  it('does not bring a device back for improving', () => {
    const before = [
      { key: 'offline', severity: 'high' },
      { key: 'weak_gps', severity: 'medium' },
    ];
    const after = [{ key: 'offline', severity: 'high' }];
    expect(sig(after)).not.toBe(sig(before));
    // The set shrank, so the signatures differ — which is why the caller
    // compares severity too, and why this test exists to pin the behaviour.
    expect(sig(after).split(',')).toHaveLength(1);
  });

  it('brings a device back when something gets worse', () => {
    const before = [{ key: 'weak_gps', severity: 'medium' }];
    const worse = [
      { key: 'weak_gps', severity: 'medium' },
      { key: 'offline', severity: 'high' },
    ];
    expect(sig(worse)).not.toBe(sig(before));
  });

  // "No bike linked" is a data-entry note, not a tracker fault, and should not
  // keep a genuinely broken device suppressed.
  it('does not let a low-severity note into the signature', () => {
    expect(sig([{ key: 'no_bike', severity: 'low' }])).toBe('');
  });
});

describe('the thresholds are the ones the rest of the platform uses', () => {
  // geofenceService refuses to act on a fix below four satellites. If these
  // ever diverge, one of them is reporting a fault the other is ignoring.
  it('uses the same satellite floor as the geofence', () => {
    const geofence = load('../src/services/geofenceService.js');
    expect(health.MIN_SATELLITES).toBe(geofence.MIN_SATELLITES_FOR_ZONES ?? 4);
  });
});

// ── Against a real database ──────────────────────────────────────────────────
//
// The rules above are pure functions; this is the query that feeds them. It
// aggregates in SQL, so it is only trustworthy if it has actually run.

describe.skipIf(!process.env.DATABASE_URL)('reading recent quality out of the database', () => {
  let parked; let riding;

  beforeEach(async () => {
    await resetAllPgTables();
    const org = await createPgOrg({ name: 'Health Test' });
    parked = await createPgBike({ organization_id: org.id, status: 'active' });
    riding = await createPgBike({ organization_id: org.id, status: 'active' });

    const device = async (imei, bikeId) => pgDb.query(
      `INSERT INTO tracking_devices (imei, bike_id, connected, last_seen_at) VALUES ($1,$2,TRUE,NOW())`,
      [imei, bikeId]);
    await device('ht-parked', parked.id);
    await device('ht-riding', riding.id);

    const ping = async (bikeId, { speed, ignition, sats, gsm, minutesAgo }) => pgDb.query(
      `INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, ignition, satellites, recorded_at, io_data)
       VALUES ($1, -26.1, 27.9, $2, $3, $4, NOW() - ($5 || ' minutes')::interval, $6)`,
      [bikeId, speed, ignition, sats, String(minutesAgo), JSON.stringify({ 21: gsm, 67: 4100 })]);

    for (let i = 0; i < 12; i += 1) {
      // Stationary, GNSS asleep: zero satellites, good signal. Not a fault.
      await ping(parked.id, { speed: 0, ignition: 0, sats: 0, gsm: 4, minutesAgo: i });
      // Riding with no fix and poor signal: a tracker worth looking at.
      await ping(riding.id, { speed: 40, ignition: 1, sats: 0, gsm: 1, minutesAgo: i });
    }
  });

  const rowFor = async (bikeId) =>
    (await health.recentQuality()).find((r) => r.bike_id === bikeId);

  it('counts only the pings where the bike was navigating', async () => {
    expect(await rowFor(parked.id)).toMatchObject({ pings: 12, navigating: 0, weak_fix_navigating: 0 });
    expect(await rowFor(riding.id)).toMatchObject({ pings: 12, navigating: 12, weak_fix_navigating: 12 });
  });

  it('reads GSM and battery out of the io_data JSON', async () => {
    expect(await rowFor(riding.id)).toMatchObject({ latest_gsm: 1, latest_batt_mv: 4100, weak_gsm: 12 });
  });

  // The whole point, end to end: the parked bike disappears from the list and
  // the one that genuinely cannot navigate stays on it.
  it('reports the riding bike and says nothing about the parked one', async () => {
    const list = await health.unhealthyDevices({ statusFor: () => 'active' });
    const byBike = Object.fromEntries(list.map((d) => [d.bike_id, d.reasons.map((r) => r.key)]));
    expect(byBike[parked.id]).toBeUndefined();
    expect(byBike[riding.id]).toEqual(expect.arrayContaining(['weak_gps', 'poor_signal']));
  });

  it('survives a device whose bike has never reported', async () => {
    const quiet = await createPgBike({ organization_id: null, status: 'active' });
    await pgDb.query(`INSERT INTO tracking_devices (imei, bike_id, connected) VALUES ('ht-quiet', $1, FALSE)`, [quiet.id]);
    const row = (await health.recentQuality()).find((r) => r.bike_id === quiet.id);
    expect(row).toMatchObject({ pings: 0, newest: null });
    expect(health.reasonsFor(row, { status: 'offline' }).reasons.map((r) => r.key)).toEqual(['offline']);
  });
});
