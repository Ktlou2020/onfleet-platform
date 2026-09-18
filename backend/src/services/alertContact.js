'use strict';

// The OnFleet number a control room should call about an alert. Weekdays from
// 08:00 until 17:00 in Johannesburg go to the office line; evenings, nights,
// weekends and South African public holidays go to the after-hours line.
//
// Decided from when the alert happened, not when it is delivered, so a delivery
// retried after 17:00 still carries the number that was right at the time. The
// timezone is explicit because the server runs on UTC: 15:30 UTC on a Monday is
// already 17:30 in Johannesburg.
//
// The numbers can be overridden without a release by setting
// ALERT_CONTACT_OFFICE_PHONE and ALERT_CONTACT_AFTER_HOURS_PHONE. Holidays the
// President declares for a single year (election days, for example) can't be
// worked out in advance; list them in ALERT_CONTACT_EXTRA_HOLIDAYS as
// comma-separated YYYY-MM-DD dates.
const OFFICE_PHONE = process.env.ALERT_CONTACT_OFFICE_PHONE || '0101411165';
const AFTER_HOURS_PHONE = process.env.ALERT_CONTACT_AFTER_HOURS_PHONE || '0815395612';
const TIMEZONE = 'Africa/Johannesburg';
const OPENS_AT_HOUR = 8;
const CLOSES_AT_HOUR = 17;

const localClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function johannesburgParts(date) {
  const parts = Object.fromEntries(localClock.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    year: Number(parts.year),
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Easter Sunday in the Gregorian calendar (the anonymous algorithm published by
// Meeus). Good Friday and Family Day move with it every year.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const holidayCache = new Map();

// South African public holidays for a year, under the Public Holidays Act 36
// of 1994. When one falls on a Sunday, the Monday after it is also a public
// holiday (section 2(1)); one that falls on a Saturday gets no replacement.
function publicHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const fixed = [[1, 1], [3, 21], [4, 27], [5, 1], [6, 16], [8, 9], [9, 24], [12, 16], [12, 25], [12, 26]];
  const easter = easterSunday(year);
  const shift = (days) => {
    const d = new Date(easter.getTime() + days * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  };
  const dates = new Set([shift(-2), shift(1)]);  // Good Friday, Family Day
  for (const [month, day] of fixed) {
    dates.add(iso(year, month, day));
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) {
      const monday = new Date(Date.UTC(year, month - 1, day + 1));
      dates.add(iso(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()));
    }
  }
  holidayCache.set(year, dates);
  return dates;
}

function extraHolidays() {
  return new Set(String(process.env.ALERT_CONTACT_EXTRA_HOLIDAYS || '')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)));
}

function isPublicHoliday(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const { year, isoDate } = johannesburgParts(date);
  return publicHolidays(year).has(isoDate) || extraHolidays().has(isoDate);
}

function isOfficeHours(at) {
  const date = at instanceof Date ? at : new Date(at);
  // An unreadable time goes to the after-hours line: that one is always answered.
  if (Number.isNaN(date.getTime())) return false;
  const { weekday, hour } = johannesburgParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  if (isPublicHoliday(date)) return false;
  return hour >= OPENS_AT_HOUR && hour < CLOSES_AT_HOUR;
}

function alertContact(at = new Date()) {
  const office = isOfficeHours(at);
  return { phone: office ? OFFICE_PHONE : AFTER_HOURS_PHONE, hours: office ? 'office' : 'after_hours' };
}

module.exports = { alertContact, isOfficeHours, isPublicHoliday, publicHolidays };
