import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { isOfficeHours, alertContact } = createRequire(import.meta.url)('../src/services/alertContact.js');

// Johannesburg is UTC+2 all year, so 06:00Z is 08:00 there. 2026-09-14 is a Monday.
const at = (utc) => new Date(utc);

describe('which OnFleet number an alert carries', () => {
  it('uses the office line from 08:00 on a weekday', () => {
    expect(isOfficeHours(at('2026-09-14T06:00:00Z'))).toBe(true);    // Mon 08:00
    expect(alertContact(at('2026-09-14T06:00:00Z'))).toEqual({ phone: '0101411165', hours: 'office' });
  });

  it('uses the after-hours line a minute before opening', () => {
    expect(isOfficeHours(at('2026-09-14T05:59:00Z'))).toBe(false);   // Mon 07:59
  });

  it('keeps the office line until 16:59 and switches at 17:00', () => {
    expect(isOfficeHours(at('2026-09-18T14:59:59Z'))).toBe(true);    // Fri 16:59:59
    expect(isOfficeHours(at('2026-09-18T15:00:00Z'))).toBe(false);   // Fri 17:00
    expect(alertContact(at('2026-09-18T15:00:00Z'))).toEqual({ phone: '0815395612', hours: 'after_hours' });
  });

  it('judges the time in Johannesburg, not on the server\'s UTC clock', () => {
    // 15:30 UTC reads as office hours on a UTC clock, but it is 17:30 in Johannesburg.
    expect(isOfficeHours(at('2026-09-14T15:30:00Z'))).toBe(false);
    // 23:30 UTC on Sunday is already 01:30 on Monday in Johannesburg: still after hours.
    expect(isOfficeHours(at('2026-09-13T23:30:00Z'))).toBe(false);
  });

  it('uses the after-hours line all weekend, even in the middle of the day', () => {
    expect(isOfficeHours(at('2026-09-19T10:00:00Z'))).toBe(false);   // Sat 12:00
    expect(isOfficeHours(at('2026-09-20T10:00:00Z'))).toBe(false);   // Sun 12:00
  });

  it('accepts the timestamp strings the database hands back', () => {
    expect(alertContact('2026-09-16T09:00:00.000Z').phone).toBe('0101411165'); // Wed 11:00
  });

  it('falls back to the after-hours line when the time cannot be read', () => {
    expect(alertContact('not a date').phone).toBe('0815395612');
  });
});

describe('South African public holidays', () => {
  const { publicHolidays, isPublicHoliday } = createRequire(import.meta.url)('../src/services/alertContact.js');
  // 08:00 UTC is 10:00 in Johannesburg: comfortably inside ordinary office hours.
  const tenAm = (isoDate) => new Date(`${isoDate}T08:00:00Z`);

  it('sends the after-hours number on a public holiday, even mid-morning on a weekday', () => {
    expect(isOfficeHours(tenAm('2026-09-24'))).toBe(false);          // Heritage Day, a Thursday
    expect(alertContact(tenAm('2026-09-24')).phone).toBe('0815395612');
    expect(isOfficeHours(tenAm('2026-09-23'))).toBe(true);           // the Wednesday before
  });

  it('lists every 2026 public holiday, including the Monday after a Sunday holiday', () => {
    expect([...publicHolidays(2026)].sort()).toEqual([
      '2026-01-01', '2026-03-21', '2026-04-03', '2026-04-06', '2026-04-27', '2026-05-01',
      '2026-06-16', '2026-08-09', '2026-08-10', '2026-09-24', '2026-12-16', '2026-12-25', '2026-12-26',
    ]);
  });

  it('moves Good Friday and Family Day with Easter every year', () => {
    const easterPair = (y) => [...publicHolidays(y)].filter((d) => d.slice(5, 7) === '03' || d.slice(5, 7) === '04')
      .filter((d) => !['03-21', '03-22', '04-27', '04-28'].includes(d.slice(5)));
    expect(easterPair(2025)).toEqual(expect.arrayContaining(['2025-04-18', '2025-04-21']));
    expect(easterPair(2027)).toEqual(expect.arrayContaining(['2027-03-26', '2027-03-29']));
    expect(easterPair(2028)).toEqual(expect.arrayContaining(['2028-04-14', '2028-04-17']));
  });

  it('makes the Monday a holiday when a holiday falls on a Sunday', () => {
    expect(isPublicHoliday(tenAm('2026-08-10'))).toBe(true);         // Women's Day was Sunday 9 Aug
    expect(isPublicHoliday(tenAm('2027-03-22'))).toBe(true);         // Human Rights Day was Sunday 21 Mar
    expect(isPublicHoliday(tenAm('2027-12-27'))).toBe(true);         // Day of Goodwill was Sunday 26 Dec
  });

  it('gives no replacement day when a holiday falls on a Saturday', () => {
    // Day of Goodwill 2026 is a Saturday; the Monday after is an ordinary working day.
    expect(isOfficeHours(tenAm('2026-12-28'))).toBe(true);
  });

  it('adds one-off holidays declared for a single year from settings', () => {
    const previous = process.env.ALERT_CONTACT_EXTRA_HOLIDAYS;
    process.env.ALERT_CONTACT_EXTRA_HOLIDAYS = '2026-10-07, not-a-date';
    try {
      expect(isOfficeHours(tenAm('2026-10-07'))).toBe(false);
      expect(isOfficeHours(tenAm('2026-10-08'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ALERT_CONTACT_EXTRA_HOLIDAYS;
      else process.env.ALERT_CONTACT_EXTRA_HOLIDAYS = previous;
    }
  });
});
