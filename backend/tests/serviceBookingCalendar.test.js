import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { pgDb, resetAllPgTables, createPgBike } from './helpers/testPgDb.js';

const booking = createRequire(import.meta.url)('../src/services/serviceBooking.js');

// Turning the admin's opening hours into a list of times a rider can tap.
//
// The arithmetic looks trivial and is not. A 30-minute job with a 15-minute
// gap means slots start every 45 minutes, which does not divide the hour, so
// a window's slots drift across it: 08:00, 08:45, 09:30, 10:15. Getting the
// end of the window wrong by one slot books a bike into the workshop's lunch.

// 2026-03-02 is a Monday. SAST is UTC+2 with no DST, so 08:00 SAST is 06:00Z.
const MONDAY = '2026-03-02';
const SUNDAY = '2026-03-08';

// resetAllPgTables truncates workshop_locations too, so each suite makes its
// own. JHB is the one these tests use unless they are about the second.
const makeLocations = async () => {
  const { rows } = await pgDb.query(
    `INSERT INTO workshop_locations (name, city, province) VALUES
       ('OnFix','Johannesburg','Gauteng'), ('Bikerhouse','Cape Town','Western Cape')
     RETURNING id`);
  return { jhb: rows[0].id, cpt: rows[1].id };
};
const noRules = () => pgDb.query('DELETE FROM service_slot_rules');
const rule = (weekday, opens, closes, locationId) =>
  pgDb.query('INSERT INTO service_slot_rules (weekday, opens_at, closes_at, location_id) VALUES ($1,$2,$3,$4)',
    [weekday, opens, closes, locationId]);

describe('converting Johannesburg wall-clock to an instant', () => {
  it('reads 08:00 in the workshop as 06:00 UTC', () => {
    expect(booking.sastToUtc(MONDAY, '08:00').toISOString()).toBe('2026-03-02T06:00:00.000Z');
  });

  // The round trip is what every slot depends on, and an off-by-two-hours here
  // would put a whole day's bookings on the wrong date near midnight.
  it('and reads it back as the same date and time', () => {
    const at = booking.sastToUtc(MONDAY, '08:00');
    expect(booking.sastDateStr(at)).toBe(MONDAY);
    expect(booking.sastTimeStr(at)).toBe('08:00');
  });

  // 01:00 SAST is 23:00 UTC the day before — the case that catches a naive
  // toISOString().slice(0,10).
  it('puts one in the morning on the right day', () => {
    expect(booking.sastDateStr(new Date('2026-03-01T23:00:00Z'))).toBe('2026-03-02');
  });

  it('agrees with the calendar about which day is Sunday', () => {
    expect(booking.weekdayOf(SUNDAY)).toBe(0);
    expect(booking.weekdayOf(MONDAY)).toBe(1);
  });
});

describe('laying slots out inside an opening window', () => {
  const slots = (opens, closes) =>
    booking.slotsForWeekday(MONDAY, [{ weekday: 1, opens_at: opens, closes_at: closes }]);

  it('starts one every 45 minutes: 30 on the bike, 15 to write it up', () => {
    expect(slots('08:00', '10:00')).toEqual(['08:00', '08:45', '09:30']);
  });

  // The boundary that matters. 11:45 + 30 minutes runs to 12:15, and the
  // workshop said it closes at twelve, so the last slot is 11:00.
  it('will not start a job that finishes after closing time', () => {
    expect(slots('08:00', '12:00')).toEqual(['08:00', '08:45', '09:30', '10:15', '11:00']);
  });

  it('fits exactly one slot into exactly half an hour', () => {
    expect(slots('08:00', '08:30')).toEqual(['08:00']);
  });

  it('fits none into twenty-nine minutes', () => {
    expect(slots('08:00', '08:29')).toEqual([]);
  });

  // A workshop that shuts for lunch has two windows, and the afternoon starts
  // its own count rather than continuing the morning's drift.
  it('restarts the count after lunch', () => {
    const day = booking.slotsForWeekday(MONDAY, [
      { weekday: 1, opens_at: '08:00', closes_at: '10:00' },
      { weekday: 1, opens_at: '13:00', closes_at: '15:00' },
    ]);
    expect(day).toEqual(['08:00', '08:45', '09:30', '13:00', '13:45', '14:30']);
  });

  it('offers nothing on a day with no rule at all', () => {
    expect(booking.slotsForWeekday(SUNDAY, [{ weekday: 1, opens_at: '08:00', closes_at: '12:00' }])).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('what the rider is actually offered', () => {
  // Friday 27 February 2026, 06:00 SAST — early enough that the whole of that
  // day is still ahead of the lead time.
  const NOW = new Date('2026-02-27T04:00:00Z');
  const FRIDAY = '2026-02-27';
  let jhb;

  beforeEach(async () => {
    await resetAllPgTables();
    ({ jhb } = await makeLocations());
    await noRules();
    await rule(5, '08:00', '12:00', jhb); // Friday mornings only
  });

  const dayOf = async (date, opts = {}) => {
    const { days } = await booking.availability({ locationId: jhb, from: date, to: date, now: NOW, ...opts });
    return days[0];
  };

  it('offers the morning on a day the workshop is open', async () => {
    const day = await dayOf(FRIDAY);
    expect(day.closed).toBe(false);
    expect(day.slots.map((s) => s.time)).toEqual(['08:00', '08:45', '09:30', '10:15', '11:00']);
    expect(day.open_count).toBe(5);
  });

  it('offers nothing on a weekday with no opening hours', async () => {
    const day = await dayOf('2026-03-05'); // the next Thursday
    expect(day.closed).toBe(true);
    expect(day.slots).toEqual([]);
  });

  it('still lists the slots on a closure day, but none of them bookable', async () => {
    await pgDb.query(`INSERT INTO service_closures (closed_on, reason, location_id) VALUES ($1,'Human Rights Day',$2)`, [FRIDAY, jhb]);
    const day = await dayOf(FRIDAY);
    expect(day.closed).toBe(true);
    expect(day.closure_reason).toBe('Human Rights Day');
    expect(day.open_count).toBe(0);
    // The rider is told why rather than shown a blank day they will phone about.
    expect(day.slots.every((s) => s.reason === 'closed')).toBe(true);
  });

  it('marks a slot somebody already has as taken', async () => {
    const bike = await createPgBike({ status: 'active' });
    await pgDb.query('INSERT INTO service_bookings (bike_id, starts_at, location_id) VALUES ($1,$2,$3)',
      [bike.id, booking.sastToUtc(FRIDAY, '09:30'), jhb]);

    const day = await dayOf(FRIDAY);
    expect(day.slots.find((s) => s.time === '09:30').reason).toBe('taken');
    expect(day.open_count).toBe(4);
  });

  // A cancelled booking must hand the slot back. Otherwise every cancellation
  // quietly shrinks the workshop's week for ever.
  it('frees a slot again once the booking is cancelled', async () => {
    const bike = await createPgBike({ status: 'active' });
    await pgDb.query(`INSERT INTO service_bookings (bike_id, starts_at, status, location_id) VALUES ($1,$2,'cancelled',$3)`,
      [bike.id, booking.sastToUtc(FRIDAY, '09:30'), jhb]);

    const day = await dayOf(FRIDAY);
    expect(day.slots.find((s) => s.time === '09:30').available).toBe(true);
  });

  it('will not let a rider take a slot that starts in twenty minutes', async () => {
    // 08:50 SAST: 09:30 is forty minutes away and inside the two-hour lead
    // time; 11:00 is two hours ten minutes away and still bookable.
    const lateNow = new Date('2026-02-27T06:50:00Z');
    const { days } = await booking.availability({ locationId: jhb, from: FRIDAY, to: FRIDAY, now: lateNow });
    expect(days[0].slots.find((s) => s.time === '09:30').reason).toBe('too_soon');
    expect(days[0].slots.find((s) => s.time === '11:00').available).toBe(true);
  });

  it('does not offer yesterday', async () => {
    const { days } = await booking.availability({ locationId: jhb, from: '2026-02-01', to: FRIDAY, now: NOW });
    expect(days[0].date).toBe(FRIDAY);
  });

  it('stops at the horizon the admin set', async () => {
    await booking.setSettings({ horizon_days: 7 });
    const { days } = await booking.availability({ locationId: jhb, from: FRIDAY, to: '2026-12-31', now: NOW });
    expect(days[days.length - 1].date).toBe('2026-03-06');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the settings behind it', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  it('has working defaults before anybody configures anything', async () => {
    expect(await booking.getSettings()).toEqual(booking.DEFAULTS);
  });

  // A blank or junk setting collapsing the horizon to zero would read to every
  // rider as "the workshop is fully booked", with nothing in any log to say so.
  it('ignores a setting that has been corrupted to nonsense', async () => {
    await pgDb.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, 'soon')`,
      [booking.SETTING_KEYS.horizon_days]);
    expect((await booking.getSettings()).horizon_days).toBe(booking.DEFAULTS.horizon_days);
  });

  it('ignores one that has been set to zero', async () => {
    await pgDb.query(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES ($1, '0')`,
      [booking.SETTING_KEYS.horizon_days]);
    expect((await booking.getSettings()).horizon_days).toBe(booking.DEFAULTS.horizon_days);
  });

  it('keeps one the admin genuinely set', async () => {
    await booking.setSettings({ horizon_days: 30, change_cutoff_hours: 48 });
    const s = await booking.getSettings();
    expect(s.horizon_days).toBe(30);
    expect(s.change_cutoff_hours).toBe(48);
    expect(s.lead_hours).toBe(booking.DEFAULTS.lead_hours);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the weekly template the admin edits', () => {
  let jhb;
  beforeEach(async () => { await resetAllPgTables(); ({ jhb } = await makeLocations()); await noRules(); });

  it('saves a week and reads it back', async () => {
    await booking.replaceRules(jhb, [
      { weekday: 1, opens_at: '08:00', closes_at: '12:00' },
      { weekday: 1, opens_at: '13:00', closes_at: '16:00' },
    ], null);
    const rules = await booking.getRules();
    expect(rules).toHaveLength(2);
    expect(rules[0].opens_at).toBe('08:00'); // 'HH:MM', not Postgres's 'HH:MM:SS'
  });

  it('replaces the previous week rather than adding to it', async () => {
    await booking.replaceRules(jhb, [{ weekday: 1, opens_at: '08:00', closes_at: '12:00' }], null);
    await booking.replaceRules(jhb, [{ weekday: 2, opens_at: '09:00', closes_at: '11:00' }], null);
    const rules = await booking.getRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].weekday).toBe(2);
  });

  it('closes the workshop entirely when the admin clears the week', async () => {
    await booking.replaceRules(jhb, [{ weekday: 1, opens_at: '08:00', closes_at: '12:00' }], null);
    await booking.replaceRules(jhb, [], null);
    expect(await booking.getRules()).toEqual([]);
  });

  it('refuses a window that ends before it starts', async () => {
    await expect(booking.replaceRules(jhb, [{ weekday: 1, opens_at: '16:00', closes_at: '08:00' }], null))
      .rejects.toThrow(/ends before it starts/);
  });

  // Overlapping windows generate the same time twice, and a rider shown 09:30
  // twice can only book one of them.
  it('refuses two windows on one day that overlap', async () => {
    await expect(booking.replaceRules(jhb, [
      { weekday: 1, opens_at: '08:00', closes_at: '12:00' },
      { weekday: 1, opens_at: '11:00', closes_at: '15:00' },
    ], null)).rejects.toThrow(/overlap/);
  });

  it('allows two that merely touch', async () => {
    await booking.replaceRules(jhb, [
      { weekday: 1, opens_at: '08:00', closes_at: '12:00' },
      { weekday: 1, opens_at: '12:00', closes_at: '15:00' },
    ], null);
    expect(await booking.getRules()).toHaveLength(2);
  });

  // A rejected week must leave the old one standing. Deleting first and
  // validating later would empty the calendar on a typo.
  it('leaves the existing week untouched when the new one is rejected', async () => {
    await booking.replaceRules(jhb, [{ weekday: 1, opens_at: '08:00', closes_at: '12:00' }], null);
    await expect(booking.replaceRules(jhb, [{ weekday: 9, opens_at: '08:00', closes_at: '12:00' }], null))
      .rejects.toThrow();
    expect(await booking.getRules()).toHaveLength(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('whether a timestamp is a slot the workshop offered', () => {
  const FRIDAY = '2026-02-27';
  let jhb;

  beforeEach(async () => {
    await resetAllPgTables();
    ({ jhb } = await makeLocations());
    await noRules();
    await rule(5, '08:00', '12:00', jhb);
  });

  it('accepts a time the rules produce', async () => {
    expect(await booking.isRealSlot(jhb, booking.sastToUtc(FRIDAY, '09:30'))).toBe(true);
  });

  // Without this a client could post any timestamp it liked. The unique index
  // stops two bookings sharing a time; it has no opinion about 09:07.
  it('rejects a time between slots', async () => {
    expect(await booking.isRealSlot(jhb, booking.sastToUtc(FRIDAY, '09:07'))).toBe(false);
  });

  it('rejects a time after the workshop closes', async () => {
    expect(await booking.isRealSlot(jhb, booking.sastToUtc(FRIDAY, '11:45'))).toBe(false);
  });

  it('rejects a day the workshop does not open', async () => {
    expect(await booking.isRealSlot(jhb, booking.sastToUtc('2026-03-01', '09:30'))).toBe(false);
  });

  it('rejects a day the workshop has closed', async () => {
    await pgDb.query(`INSERT INTO service_closures (closed_on, reason, location_id) VALUES ($1,'Stocktake',$2)`, [FRIDAY, jhb]);
    expect(await booking.isRealSlot(jhb, booking.sastToUtc(FRIDAY, '09:30'))).toBe(false);
  });

  it('rejects something that is not a date at all', async () => {
    expect(await booking.isRealSlot(jhb, 'not a date')).toBe(false);
  });
});

describe('the cutoff on changing your mind', () => {
  const NOW = new Date('2026-02-27T08:00:00Z');
  const hoursOut = (h) => new Date(NOW.getTime() + h * 60 * 60 * 1000);

  it('lets a rider move a booking three days out', () => {
    expect(booking.withinChangeCutoff(hoursOut(72), 24, NOW)).toBe(true);
  });

  it('stops them the morning before', () => {
    expect(booking.withinChangeCutoff(hoursOut(20), 24, NOW)).toBe(false);
  });

  it('stops them on a booking that has already passed', () => {
    expect(booking.withinChangeCutoff(hoursOut(-2), 24, NOW)).toBe(false);
  });
});
