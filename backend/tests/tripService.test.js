import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import { resetAllTables, createBike } from './helpers/testDb.js';

// tripService talks to Postgres (pgDb) for trips/tracking_alerts via a plain CJS
// require(), which vi.mock cannot intercept transitively. Instead, inject a fake
// module directly into Node's own require cache at pgDb's resolved path before
// tripService is first required, so tripService's `require('../pgDb')` picks up
// our fake. The fake returns just enough shape for processPing to run, and lets
// us assert on what SQL it issued — which trip-table statement fired is exactly
// the observable signal of whether processPing decided to open or close a trip.
const requireFromHere = createRequire(import.meta.url);
const pgDbPath = requireFromHere.resolve('../src/pgDb.js');

let queryLog;
const queryMock = vi.fn(async (sql, params) => {
  queryLog.push({ sql, params });
  if (sql.includes('INSERT INTO trips')) return { rows: [{ id: queryLog.length }] };
  if (sql.includes('INSERT INTO tracking_alerts')) return { rows: [{ id: queryLog.length }] };
  return { rows: [] };
});

requireFromHere.cache[pgDbPath] = {
  id: pgDbPath,
  filename: pgDbPath,
  loaded: true,
  exports: { pool: null, query: (...args) => queryMock(...args) },
};

const tripService = requireFromHere('../src/services/tripService.js');

beforeEach(() => {
  resetAllTables();
  queryLog = [];
  queryMock.mockClear();
});

function tripInserts() { return queryLog.filter(q => q.sql.includes('INSERT INTO trips')); }
function tripEndUpdates() { return queryLog.filter(q => q.sql.includes('UPDATE trips SET ended_at')); }

const T0 = new Date('2026-01-05T10:00:00.000Z').getTime();
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

describe('processPing — devices that report an ignition signal', () => {
  it('does not open a trip while moving with ignition off', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, 0, iso(0), {});
    expect(tripInserts()).toHaveLength(0);
  });

  it('opens a trip when moving with ignition on', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, 1, iso(0), {});
    expect(tripInserts()).toHaveLength(1);
  });

  it('does not open a trip when ignition is on but stationary', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 0, 1, iso(0), {});
    expect(tripInserts()).toHaveLength(0);
  });

  it('keeps a trip open across pings while ignition stays on', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, 1, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 25, 1, iso(30_000), {});
    await tripService.processPing(bike.id, 1, -26.12, 28.02, 22, 1, iso(60_000), {});
    expect(tripInserts()).toHaveLength(1);
    expect(tripEndUpdates()).toHaveLength(0);
  });

  it('ends the trip the instant ignition goes off', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, 1, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, 0, iso(30_000), {});
    expect(tripEndUpdates()).toHaveLength(1);
  });
});

describe('processPing — devices with no ignition signal (io[239] absent, ignition=null)', () => {
  it('opens a trip on movement alone', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    expect(tripInserts()).toHaveLength(1);
  });

  it('does not open a trip while stationary', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 0, null, iso(0), {});
    expect(tripInserts()).toHaveLength(0);
  });

  it('keeps the trip open through a brief stop (<5 min)', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000), {});   // stopped
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000 + 4 * 60_000), {}); // still <5min stopped
    expect(tripInserts()).toHaveLength(1);
    expect(tripEndUpdates()).toHaveLength(0);
  });

  it('resumes the stationary timer if movement resumes before 5 min', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000), {});               // stopped
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000 + 4 * 60_000), {});  // still stopped, 4 min in
    await tripService.processPing(bike.id, 1, -26.12, 28.02, 15, null, iso(60_000 + 4 * 60_000 + 1000), {}); // moving again
    // another 4+ minutes stopped after the resume shouldn't end it — the clock reset
    await tripService.processPing(bike.id, 1, -26.12, 28.02, 0, null, iso(60_000 + 4 * 60_000 + 1000 + 4 * 60_000), {});
    expect(tripEndUpdates()).toHaveLength(0);
  });

  it('ends the trip after 5 minutes stationary', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000), {}); // stopped at t=60s
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000 + 5 * 60_000 + 1000), {}); // 5min+1s later, still stopped
    expect(tripEndUpdates()).toHaveLength(1);
  });

  it('opens a fresh trip after ending one, on the next movement', async () => {
    const bike = createBike();
    await tripService.processPing(bike.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000), {});
    await tripService.processPing(bike.id, 1, -26.11, 28.01, 0, null, iso(60_000 + 5 * 60_000 + 1000), {}); // ends trip 1
    await tripService.processPing(bike.id, 1, -26.12, 28.02, 18, null, iso(60_000 + 5 * 60_000 + 1000 + 1000), {}); // new trip

    expect(tripInserts()).toHaveLength(2);
    expect(tripEndUpdates()).toHaveLength(1);
  });

  it('tracks bikes independently — one bike stopping does not affect another bike mid-trip', async () => {
    const bikeA = createBike();
    const bikeB = createBike();
    await tripService.processPing(bikeA.id, 1, -26.1, 28.0, 20, null, iso(0), {});
    await tripService.processPing(bikeB.id, 2, -26.2, 28.1, 20, null, iso(0), {});
    // bike A stops for >5 min
    await tripService.processPing(bikeA.id, 1, -26.1, 28.0, 0, null, iso(60_000), {});
    await tripService.processPing(bikeA.id, 1, -26.1, 28.0, 0, null, iso(60_000 + 5 * 60_000 + 1000), {});
    // bike B keeps moving the whole time
    await tripService.processPing(bikeB.id, 2, -26.21, 28.11, 20, null, iso(60_000 + 5 * 60_000 + 1000), {});

    expect(tripEndUpdates()).toHaveLength(1);
  });
});
