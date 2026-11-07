'use strict';

// Everything that decides what may be sold, to whom, and when lives here, so
// it can be reviewed by a lawyer in one place and changed without touching
// the order flow.

const MIN_AGE = 18;

function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// South African ID: YYMMDD SSSS C A Z — date of birth, sequence (gender),
// citizenship, a legacy digit, and a Luhn check digit.
function parseSaId(raw, now = new Date()) {
  const id = String(raw || '').replace(/\s/g, '');
  if (!/^\d{13}$/.test(id)) return { valid: false, reason: 'An ID number is 13 digits' };
  if (!luhnValid(id)) return { valid: false, reason: 'That ID number does not check out — please re-type it' };
  if (!['0', '1', '2'].includes(id[10])) return { valid: false, reason: 'That ID number does not check out — please re-type it' };

  const yy = Number(id.slice(0, 2));
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  const currentYy = now.getUTCFullYear() % 100;
  const year = yy > currentYy ? 1900 + yy : 2000 + yy;
  const dob = new Date(Date.UTC(year, mm - 1, dd));
  if (dob.getUTCFullYear() !== year || dob.getUTCMonth() !== mm - 1 || dob.getUTCDate() !== dd) {
    return { valid: false, reason: 'The date of birth in that ID number is not a real date' };
  }
  if (dob > now) return { valid: false, reason: 'The date of birth in that ID number is in the future' };

  return {
    valid: true,
    dob: dob.toISOString().slice(0, 10),
    age: ageOn(dob, now),
    gender: Number(id.slice(6, 10)) >= 5000 ? 'male' : 'female',
    citizen: id[10] === '0',
  };
}

function ageOn(dob, now) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

function isAdult(parsed) {
  return parsed.valid && parsed.age >= MIN_AGE;
}

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    regulatedSalesEnabled: s.regulated_sales_enabled === 'true',
    deliveryOpenHour: Number(s.delivery_open_hour ?? 8),
    deliveryCloseHour: Number(s.delivery_close_hour ?? 22),
  };
}

// A regulated category is only live when the platform switch is on AND the
// store's licence has been verified by an admin AND covers that category.
// Unregulated categories (accessories, papers, grow kit, exempt CBD) are
// always live.
// SAST calendar date, YYYY-MM-DD.
function sastToday(now = new Date()) {
  return new Date(now.getTime() + 2 * 3600e3).toISOString().slice(0, 10);
}
// A licence is good up to and including its expiry date.
function licenceExpired(store, now = new Date()) {
  return !!store.licence_expires_on && store.licence_expires_on < sastToday(now);
}

function canSell({ category, store, settings }) {
  if (!category.regulated) return { ok: true };
  if (!settings.regulatedSalesEnabled) return { ok: false, reason: 'Regulated sales are switched off platform-wide' };
  if (!store.licence_verified) return { ok: false, reason: 'Store licence not yet verified' };
  if (licenceExpired(store)) return { ok: false, reason: 'Store licence has expired' };
  const covered = JSON.parse(store.licence_categories || '[]');
  if (!covered.includes(category.slug)) return { ok: false, reason: `Licence does not cover ${category.name}` };
  return { ok: true };
}

// South Africa has no daylight saving, so SAST is always UTC+2.
function sastHour(now = new Date()) {
  return (now.getUTCHours() + 2) % 24;
}

function deliveryWindowOpen(settings, now = new Date()) {
  const h = sastHour(now);
  return h >= settings.deliveryOpenHour && h < settings.deliveryCloseHour;
}

module.exports = { MIN_AGE, parseSaId, isAdult, getSettings, canSell, deliveryWindowOpen, sastHour, sastToday, licenceExpired };
