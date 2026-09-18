'use strict';

// The OnFleet number a control room should call about an alert. Weekdays from
// 08:00 until 17:00 in Johannesburg go to the office line; evenings, nights and
// weekends go to the after-hours line.
//
// Decided from when the alert happened, not when it is delivered, so a delivery
// retried after 17:00 still carries the number that was right at the time. The
// timezone is explicit because the server runs on UTC: 15:30 UTC on a Monday is
// already 17:30 in Johannesburg.
//
// The numbers can be overridden without a release by setting
// ALERT_CONTACT_OFFICE_PHONE and ALERT_CONTACT_AFTER_HOURS_PHONE.
const OFFICE_PHONE = process.env.ALERT_CONTACT_OFFICE_PHONE || '0101411165';
const AFTER_HOURS_PHONE = process.env.ALERT_CONTACT_AFTER_HOURS_PHONE || '0815395612';
const TIMEZONE = 'Africa/Johannesburg';
const OPENS_AT_HOUR = 8;
const CLOSES_AT_HOUR = 17;

const localClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
});

function isOfficeHours(at) {
  const date = at instanceof Date ? at : new Date(at);
  // An unreadable time goes to the after-hours line: that one is always answered.
  if (Number.isNaN(date.getTime())) return false;
  const parts = localClock.formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= OPENS_AT_HOUR && hour < CLOSES_AT_HOUR;
}

function alertContact(at = new Date()) {
  const office = isOfficeHours(at);
  return { phone: office ? OFFICE_PHONE : AFTER_HOURS_PHONE, hours: office ? 'office' : 'after_hours' };
}

module.exports = { alertContact, isOfficeHours };
