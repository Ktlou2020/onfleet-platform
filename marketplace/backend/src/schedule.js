'use strict';
const { deliveryWindowOpen } = require('./compliance');
const { availability } = require('./storeHours');

// When can an order placed now actually be delivered? Right away if the
// platform's delivery hours and the store's own opening hours both allow
// it; otherwise at the first moment they both do. A store that is paused
// or switched off can't take orders at all — nobody is there to pack them.

const STEP_MINUTES = 15;
const HORIZON_DAYS = 8;

function sastLabel(date, now = new Date()) {
  const t = new Date(date.getTime() + 2 * 3600e3);
  const n = new Date(now.getTime() + 2 * 3600e3);
  const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const dayDiff = Math.round((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 864e5);
  const day = dayDiff === 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : t.toLocaleDateString('en-ZA', { weekday: 'long', timeZone: 'UTC' });
  return `${day} at ${hhmm}`;
}

function deliverableAt(store, settings, t) {
  return deliveryWindowOpen(settings, t) && availability({ ...store, paused_until: null }, t).open;
}

// Returns { now: true } | { now: false, at: Date, label } | { blocked: reason }.
function deliveryStart(store, settings, now = new Date()) {
  const avail = availability(store, now);
  if (avail.reason === 'closed') return { blocked: `${store.name} is closed right now` };
  if (avail.reason === 'paused') return { blocked: `${store.name} is very busy — ${avail.label.toLowerCase()}` };
  if (deliverableAt(store, settings, now)) return { now: true };
  // Walk forward on the quarter hour until both are open.
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(Math.ceil((t.getUTCMinutes() + 1) / STEP_MINUTES) * STEP_MINUTES);
  for (let i = 0; i < (HORIZON_DAYS * 24 * 60) / STEP_MINUTES; i++) {
    if (deliverableAt(store, settings, t)) return { now: false, at: new Date(t), label: sastLabel(t, now) };
    t.setUTCMinutes(t.getUTCMinutes() + STEP_MINUTES);
  }
  return { blocked: `${store.name} has no delivery times in the next week` };
}

module.exports = { deliveryStart, sastLabel };
