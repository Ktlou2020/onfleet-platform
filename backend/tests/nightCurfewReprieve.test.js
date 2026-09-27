import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const curfew = createRequire(import.meta.url)('../src/services/nightCurfew.js');

// Breaking the loop an operator cannot break themselves.
//
// MJ71MRGP moved after midnight and the curfew cut it, which is what it is
// for. The control room restored the engine and it was cut again, and again:
// night_movement re-fired after its cooldown, re-armed the curfew, and the
// bike died the next time it slowed to walking pace. Every individual decision
// was right and the result was unusable.
//
// Restoring an engine at one in the morning is somebody deciding that this
// bike is allowed to be moving. The curfew has to be able to hear that — for
// tonight, and only tonight.

// SAST is UTC+2, so 01:00 SAST is 23:00 UTC the day before.
const AT_0100_SAST = new Date('2026-09-26T23:00:00Z');
const AT_0330_SAST = new Date('2026-09-27T01:30:00Z');
const AT_1400_SAST = new Date('2026-09-27T12:00:00Z');

describe('when the curfew window is', () => {
  it('open at 01:00 and 03:30 SAST', () => {
    expect(curfew.inCurfew(AT_0100_SAST)).toBe(true);
    expect(curfew.inCurfew(AT_0330_SAST)).toBe(true);
  });

  it('closed at two in the afternoon', () => {
    expect(curfew.inCurfew(AT_1400_SAST)).toBe(false);
  });

  it('ends at 04:00 SAST on the morning the window belongs to', () => {
    // 01:00 SAST on the 27th is 23:00 UTC on the 26th; the window it is in
    // ends at 04:00 SAST on the 27th, which is 02:00 UTC.
    expect(curfew.windowEnd(AT_0100_SAST).toISOString()).toBe('2026-09-27T02:00:00.000Z');
    expect(curfew.windowEnd(AT_0330_SAST).toISOString()).toBe('2026-09-27T02:00:00.000Z');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a bike whose engine is restored during the curfew', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    curfew.clearAll();
    bike = await createPgBike({ status: 'active' });
  });

  const reprieveOf = async (id) =>
    (await pgDb.query('SELECT night_curfew_reprieve_until FROM bikes WHERE id = $1', [id]))
      .rows[0].night_curfew_reprieve_until;

  it('is covered by the curfew before anybody intervenes', async () => {
    expect(await curfew.covers(bike.id, { at: AT_0100_SAST })).toBe(true);
  });

  it('is reprieved until the window closes', async () => {
    const until = await curfew.grantReprieve(bike.id, { at: AT_0100_SAST });
    expect(until.toISOString()).toBe('2026-09-27T02:00:00.000Z');
    expect(await reprieveOf(bike.id)).not.toBeNull();
  });

  // The fault itself: without this, the next night_movement alert re-arms the
  // cut and the bike dies again fifteen minutes later.
  it('is not cut again for the rest of that night', async () => {
    await curfew.grantReprieve(bike.id, { at: AT_0100_SAST });
    expect(await curfew.covers(bike.id, { at: AT_0330_SAST })).toBe(false);
    expect(await curfew.arm(bike.id, 99, {}, { at: AT_0330_SAST })).toBe(false);
  });

  // And the protection comes back on its own. Nobody has to remember.
  it('is covered again the following night', async () => {
    await curfew.grantReprieve(bike.id, { at: AT_0100_SAST });
    const tomorrow = new Date('2026-09-27T23:00:00Z'); // 01:00 SAST on the 28th
    expect(await curfew.covers(bike.id, { at: tomorrow })).toBe(true);
  });

  it('has its pending cut dropped as well, not just future ones blocked', async () => {
    await curfew.arm(bike.id, 99, {}, { at: AT_0100_SAST });
    expect(curfew.isArmed(bike.id)).toBe(true);
    await curfew.grantReprieve(bike.id, { at: AT_0100_SAST });
    expect(curfew.isArmed(bike.id)).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a bike whose engine is restored in daylight', () => {
  let bike;

  beforeEach(async () => {
    await resetAllPgTables();
    curfew.clearAll();
    bike = await createPgBike({ status: 'active' });
  });

  // An arrears cut restored at two in the afternoon says nothing about
  // tonight. Granting a reprieve then would quietly stand the curfew down for
  // a night nobody was thinking about.
  it('gets no reprieve, and is still covered that night', async () => {
    expect(await curfew.grantReprieve(bike.id, { at: AT_1400_SAST })).toBeNull();
    const tonight = new Date('2026-09-27T23:00:00Z');
    expect(await curfew.covers(bike.id, { at: tonight })).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the exemptions that already existed', () => {
  beforeEach(async () => { await resetAllPgTables(); curfew.clearAll(); });

  it('still exempts a bike marked permanently exempt', async () => {
    const bike = await createPgBike({ status: 'active' });
    await pgDb.query('UPDATE bikes SET night_curfew_exempt = TRUE WHERE id = $1', [bike.id]);
    expect(await curfew.covers(bike.id, { at: AT_0100_SAST })).toBe(false);
  });

  it('still leaves a bike OnFleet no longer owns alone', async () => {
    const bike = await createPgBike({ status: 'paid_off' });
    expect(await curfew.covers(bike.id, { at: AT_0100_SAST })).toBe(false);
  });
});
