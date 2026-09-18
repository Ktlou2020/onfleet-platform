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
