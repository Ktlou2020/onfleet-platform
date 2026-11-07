'use strict';

// Whether a store is taking orders right now, and if not, why and until
// when. Three things can close a store: the owner's open/closed switch, a
// temporary pause ("busy, back in 30 minutes"), and its weekly opening
// hours. Hours are in SAST, which is UTC+2 all year.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

function sastNow(now = new Date()) {
  const t = new Date(now.getTime() + 2 * 3600e3);
  return { day: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

// { mon: ['09:00', '21:00'], sun: null, ... }; a missing table means no
// hours are set and the platform's delivery hours are the only limit.
function parseHours(raw) {
  if (!raw) return null;
  try {
    const h = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return h && typeof h === 'object' ? h : null;
  } catch {
    return null;
  }
}

function validateHours(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object') throw new Error('Opening hours are not in the right shape');
  const out = {};
  for (const d of DAYS) {
    const v = input[d];
    if (v === null || v === undefined || v === false) { out[d] = null; continue; }
    if (!Array.isArray(v) || v.length !== 2 || !TIME.test(v[0]) || !TIME.test(v[1])) throw new Error(`Use HH:MM times for ${d}`);
    if (toMinutes(v[1]) <= toMinutes(v[0])) throw new Error(`Closing must be after opening on ${d}`);
    out[d] = [v[0], v[1]];
  }
  return out;
}

function nextOpening(hours, now) {
  const { day, minutes } = sastNow(now);
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    const slot = hours[DAYS[d]];
    if (!slot) continue;
    if (i === 0 && toMinutes(slot[0]) <= minutes) continue;
    return { day: d, time: slot[0], label: i === 0 ? `today at ${slot[0]}` : i === 1 ? `tomorrow at ${slot[0]}` : `${DAY_NAMES[d]} at ${slot[0]}` };
  }
  return null;
}

function availability(store, now = new Date()) {
  if (!store.is_open) return { open: false, reason: 'closed', label: 'Closed' };
  if (store.paused_until && new Date(store.paused_until) > now) {
    const until = new Date(store.paused_until);
    const t = new Date(until.getTime() + 2 * 3600e3);
    const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
    return { open: false, reason: 'paused', until: store.paused_until, label: `Busy — back at ${hhmm}` };
  }
  const hours = parseHours(store.hours);
  if (hours) {
    const { day, minutes } = sastNow(now);
    const slot = hours[DAYS[day]];
    if (!slot || minutes < toMinutes(slot[0]) || minutes >= toMinutes(slot[1])) {
      const next = nextOpening(hours, now);
      return { open: false, reason: 'hours', label: next ? `Opens ${next.label}` : 'Closed' };
    }
    return { open: true, closesAt: slot[1], label: `Open until ${slot[1]}` };
  }
  return { open: true, label: 'Open' };
}

// A product can be limited to some days and/or a time of day ("from 10:00",
// "not on Sundays"). Empty means always, when the store is open.
function productAvailability(p, now = new Date()) {
  const { day, minutes } = sastNow(now);
  let days = null;
  try { days = p.available_days ? JSON.parse(p.available_days) : null; } catch { days = null; }
  if (Array.isArray(days) && days.length && !days.includes(DAYS[day])) return { now: false, label: 'Not available today' };
  if (p.available_from && minutes < toMinutes(p.available_from)) return { now: false, label: `Available from ${p.available_from}` };
  if (p.available_to && minutes >= toMinutes(p.available_to)) return { now: false, label: 'Finished for today' };
  return { now: true, label: null };
}

function validateWindow(days, from, to) {
  if (days != null && (!Array.isArray(days) || days.some((d) => !DAYS.includes(d)))) throw new Error('Pick days from mon to sun');
  for (const t of [from, to]) if (t && !TIME.test(t)) throw new Error('Use HH:MM times');
  if (from && to && toMinutes(to) <= toMinutes(from)) throw new Error('The end time must be after the start time');
}

module.exports = { DAYS, availability, parseHours, validateHours, productAvailability, validateWindow };
