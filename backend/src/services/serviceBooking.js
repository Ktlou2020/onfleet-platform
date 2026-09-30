'use strict';

// The workshop diary.
//
// Booking a service has been a phone call, or one of two hardcoded Google
// Calendar links on the rider's agreement page. Meanwhile serviceDue.js can
// say a bike is 400 km past its interval and the daily reminder tells fleet
// admins to "contact us to book your service appointments" — a reminder with
// nowhere to go.
//
// Slots are computed from the admin's weekly rules, never stored. See the
// migration for why. Everything in here is about turning those rules into a
// list of times and deciding which of them a rider may actually take.

const pgDb = require('../pgDb');

// 30 minutes on the bike, 15 minutes to write it up and wheel the next one in,
// so slots start every 45 minutes.
const SLOT_MINUTES = 30;
const GAP_MINUTES = 15;
const CADENCE_MINUTES = SLOT_MINUTES + GAP_MINUTES;

// South Africa has no DST, so Africa/Johannesburg is always UTC+2. The same
// constant is derived independently in nightCurfew.js, riskService.js,
// tripService.js and routes/tracking.js; it is repeated here rather than
// reaching across a service boundary for it, and consolidating all five is
// worth doing on its own.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

const LIVE_STATUSES = ['booked', 'arrived'];

// Defaults chosen to be obviously sane rather than clever; all three are
// overridable from app_settings without a deploy.
const DEFAULTS = {
  horizon_days: 60,      // how far ahead riders may book
  lead_hours: 2,         // no booking a slot that starts in twenty minutes
  change_cutoff_hours: 24, // after this, a rider must phone the workshop
};

const SETTING_KEYS = {
  horizon_days: 'service_booking_horizon_days',
  lead_hours: 'service_booking_lead_hours',
  change_cutoff_hours: 'service_booking_change_cutoff_hours',
};

// ---------------------------------------------------------------- time ----
//
// Slot times are wall-clock facts about a workshop in Johannesburg: "half past
// nine on Tuesday" does not change meaning because the server moved. They are
// stored as timestamptz and converted at both edges.

function sastToUtc(dateStr, timeStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - SAST_OFFSET_MS);
}

// The calendar date, in Johannesburg, that an instant falls on.
function sastDateStr(at) {
  return new Date(new Date(at).getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

function sastTimeStr(at) {
  return new Date(new Date(at).getTime() + SAST_OFFSET_MS).toISOString().slice(11, 16);
}

// 0 = Sunday, matching getDay(), EXTRACT(DOW) and the weekday column.
function weekdayOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function minutesOf(timeStr) {
  const [hh, mm] = String(timeStr).split(':').map(Number);
  return hh * 60 + mm;
}

function timeStrOf(minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ------------------------------------------------------------ settings ----

async function getSettings({ db = pgDb } = {}) {
  const { rows } = await db.query(
    'SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)',
    [Object.values(SETTING_KEYS)]
  );
  const stored = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  const out = {};
  for (const [name, key] of Object.entries(SETTING_KEYS)) {
    const raw = Number(stored[key]);
    // A blank or corrupted setting must not collapse the calendar to zero days
    // ahead, which would read to a rider as "the workshop is fully booked".
    out[name] = Number.isFinite(raw) && raw > 0 ? raw : DEFAULTS[name];
  }
  return out;
}

async function setSettings(patch, { db = pgDb } = {}) {
  for (const [name, value] of Object.entries(patch)) {
    const key = SETTING_KEYS[name];
    if (!key) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    await db.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [key, String(Math.round(n))]
    );
  }
  return getSettings({ db });
}

// ------------------------------------------------------- the workshops ----
//
// Two of them: OnFix in Johannesburg and Bikerhouse in Cape Town. Everything
// below takes a location, because a slot at one says nothing about the other.

// Which workshops an organisation may see.
//
//   NULL organization_id   the platform offers it to everybody
//   a matching id          it belongs to this fleet
//
// Seeing everything is stated, never inferred from a missing organisation.
//
// The first version of this treated `orgId == null` as "platform staff, sees
// the lot". That is true of an admin and a technician, and quietly false of a
// rider with no organisation of their own riding a fleet's motorcycle — who
// would have been shown every fleet's private workshops. Two very different
// situations arriving at the same value is exactly the bug this whole change
// exists to remove, so the two are now separate arguments:
//
//   seesAll          platform staff. Says so.
//   orgId            the organisation whose workshops these are. Null with
//                    seesAll false means shared workshops only, which is the
//                    right answer for somebody with no fleet behind them.
function visibilityClause({ seesAll = false, orgId = null } = {}, alias = 'wl', index = 1) {
  if (seesAll) return { clause: 'TRUE', params: [] };
  if (orgId == null) return { clause: `${alias}.organization_id IS NULL`, params: [] };
  return {
    clause: `(${alias}.organization_id IS NULL OR ${alias}.organization_id = $${index})`,
    params: [Number(orgId)],
  };
}

/**
 * The workshops this caller may see.
 *
 * `inactiveOwnerId` is the one exception to activeOnly: a fleet owner has to
 * see their own switched-off workshop or they cannot switch it back on, while
 * somebody else's switched-off workshop stays none of their business.
 */
async function getLocations({ scope = {}, activeOnly = true, inactiveOwnerId = null, db = pgDb } = {}) {
  const vis = visibilityClause(scope, 'wl', 1);
  const where = [vis.clause];
  const params = [...vis.params];
  if (activeOnly) {
    if (inactiveOwnerId != null) {
      params.push(Number(inactiveOwnerId));
      where.push(`(wl.active = TRUE OR wl.organization_id = $${params.length})`);
    } else {
      where.push('wl.active = TRUE');
    }
  }
  // The owner's name travels with it. Without it a platform admin looking at
  // the list sees an organization_id and has to go and look up whose it is,
  // which is the sort of friction that ends in somebody editing the wrong
  // fleet's workshop.
  const { rows } = await db.query(
    `SELECT wl.id, wl.name, wl.city, wl.province, wl.address, wl.phone, wl.active,
            wl.organization_id, o.name AS organization_name
       FROM workshop_locations wl
       LEFT JOIN organizations o ON o.id = wl.organization_id
      WHERE ${where.join(' AND ')}
      ORDER BY wl.organization_id NULLS LAST, wl.id`, params);
  return rows;
}

/**
 * May this organisation use this workshop?
 *
 * Both halves in one statement rather than fetching and then checking:
 * separating them is how a check gets forgotten on the third caller.
 */
async function locationExists(locationId, { scope = {}, db = pgDb } = {}) {
  if (!Number.isInteger(Number(locationId))) return false;
  const vis = visibilityClause(scope, 'workshop_locations', 2);
  const { rows } = await db.query(
    `SELECT 1 FROM workshop_locations
      WHERE id = $1 AND active = TRUE AND ${vis.clause}`,
    [Number(locationId), ...vis.params]);
  return rows.length > 0;
}

// Which workshop to show a rider first.
//
// Their province if it matches one, otherwise wherever they last booked,
// otherwise the first. Getting this right matters more than it looks: a Cape
// Town rider who is shown Johannesburg and does not notice the selector books
// a slot 1,400 km away, and nobody finds out until the bike does not arrive.
async function defaultLocationFor(userId, { scope = {}, db = pgDb } = {}) {
  const locations = await getLocations({ scope, db });
  if (locations.length === 0) return null;

  // Where they last went, but only if they may still go there — a workshop
  // can be switched off, or stop being shared, after a booking was made.
  const allowed = new Set(locations.map((l) => l.id));
  const { rows: last } = await db.query(
    `SELECT sb.location_id FROM service_bookings sb
       JOIN workshop_locations l ON l.id = sb.location_id AND l.active = TRUE
      WHERE sb.booked_by = $1 ORDER BY sb.created_at DESC LIMIT 1`, [userId]);
  if (last[0] && allowed.has(last[0].location_id)) return last[0].location_id;

  const { rows: user } = await db.query('SELECT province FROM users WHERE id = $1', [userId]);
  const province = String(user[0]?.province || '').trim().toLowerCase();
  if (province) {
    const match = locations.find((l) => String(l.province || '').trim().toLowerCase() === province);
    if (match) return match.id;
  }
  return locations[0].id;
}

// ----------------------------------------------------------- the rules ----

async function getRules({ locationId = null, db = pgDb } = {}) {
  const { rows } = await db.query(
    `SELECT id, weekday, opens_at, closes_at, location_id FROM service_slot_rules
      ${locationId ? 'WHERE location_id = $1' : ''} ORDER BY location_id, weekday, opens_at`,
    locationId ? [Number(locationId)] : []
  );
  // Postgres hands back TIME as 'HH:MM:SS'; the whole rest of this module and
  // every form field that edits it speaks 'HH:MM'.
  return rows.map((r) => ({ ...r, opens_at: String(r.opens_at).slice(0, 5), closes_at: String(r.closes_at).slice(0, 5) }));
}

// The admin edits the week as a whole and saves it, so this replaces the lot
// in one transaction rather than diffing. A half-applied week is a workshop
// open at hours nobody chose.
async function replaceRules(locationId, windows, userId, { db = pgDb } = {}) {
  // seesAll: this is an existence check, not an authorisation one. Whether
  // the caller may touch this workshop was settled by the route before it got
  // here, and having the default scope silently apply here meant a fleet
  // could not set hours on its own workshop.
  if (!(await locationExists(locationId, { scope: { seesAll: true }, db }))) {
    throw Object.assign(new Error('Which workshop?'), { status: 400 });
  }
  const clean = [];
  for (const w of windows || []) {
    const weekday = Number(w.weekday);
    const opens = String(w.opens_at || '').slice(0, 5);
    const closes = String(w.closes_at || '').slice(0, 5);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw Object.assign(new Error('Day must be Sunday through Saturday'), { status: 400 });
    }
    if (!/^\d{2}:\d{2}$/.test(opens) || !/^\d{2}:\d{2}$/.test(closes)) {
      throw Object.assign(new Error('Times must look like 08:00'), { status: 400 });
    }
    if (minutesOf(closes) <= minutesOf(opens)) {
      throw Object.assign(new Error(`${opens}–${closes} ends before it starts`), { status: 400 });
    }
    clean.push({ weekday, opens, closes });
  }

  // Overlapping windows on one day would generate the same slot twice and the
  // rider would see a duplicate time that cannot both be booked.
  for (let d = 0; d <= 6; d += 1) {
    const day = clean.filter((w) => w.weekday === d).sort((a, z) => minutesOf(a.opens) - minutesOf(z.opens));
    for (let i = 1; i < day.length; i += 1) {
      if (minutesOf(day[i].opens) < minutesOf(day[i - 1].closes)) {
        throw Object.assign(new Error(`${day[i - 1].opens}–${day[i - 1].closes} and ${day[i].opens}–${day[i].closes} overlap`), { status: 400 });
      }
    }
  }

  // Scoped to this workshop: saving OnFix's week must not wipe Bikerhouse's.
  await pgDb.withTransaction(async (tx) => {
    await tx.query('DELETE FROM service_slot_rules WHERE location_id = $1', [Number(locationId)]);
    for (const w of clean) {
      await tx.query(
        'INSERT INTO service_slot_rules (weekday, opens_at, closes_at, updated_by, location_id) VALUES ($1,$2,$3,$4,$5)',
        [w.weekday, w.opens, w.closes, userId || null, Number(locationId)]
      );
    }
  });
  return getRules({ locationId, db });
}

async function getClosures({ locationId = null, from = null, to = null, db = pgDb } = {}) {
  const where = [];
  const params = [];
  if (locationId) { params.push(Number(locationId)); where.push(`location_id = $${params.length}`); }
  if (from) { params.push(from); where.push(`closed_on >= $${params.length}`); }
  if (to) { params.push(to); where.push(`closed_on <= $${params.length}`); }
  const { rows } = await db.query(
    `SELECT id, closed_on, reason, location_id FROM service_closures
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY closed_on`, params
  );
  return rows.map((r) => ({ ...r, closed_on: sastDateStr(r.closed_on) }));
}

// ----------------------------------------------------------- the slots ----

// Every slot a day's rules produce, ignoring bookings and closures. A window
// only yields a slot if the full 30 minutes fits inside it: a window ending at
// 12:00 stops at 11:00, because 11:45 would run to 12:15 and the workshop
// said it closes at twelve.
function slotsForWeekday(dateStr, rules) {
  const out = [];
  for (const rule of rules.filter((r) => Number(r.weekday) === weekdayOf(dateStr))) {
    const open = minutesOf(rule.opens_at);
    const close = minutesOf(rule.closes_at);
    for (let t = open; t + SLOT_MINUTES <= close; t += CADENCE_MINUTES) {
      out.push(timeStrOf(t));
    }
  }
  return out.sort();
}

// What a rider (or an admin) sees when they open the calendar.
//
// `now` is injectable because every interesting case here is about time — a
// slot that has passed, one inside the lead window, one beyond the horizon —
// and a test that cannot move the clock can only assert the boring ones.
async function availability({ locationId, scope = {}, from, to, now = new Date(), db = pgDb, ignoreHorizon = false } = {}) {
  if (!(await locationExists(locationId, { scope, db }))) {
    throw Object.assign(new Error('Which workshop?'), { status: 400 });
  }
  const settings = await getSettings({ db });
  const today = sastDateStr(now);
  const firstDay = from && from > today ? from : today;
  const horizonEnd = addDays(today, settings.horizon_days);
  let lastDay = to || addDays(today, 13);
  if (!ignoreHorizon && lastDay > horizonEnd) lastDay = horizonEnd;

  const rules = await getRules({ locationId, db });
  const closures = await getClosures({ locationId, from: firstDay, to: lastDay, db });
  const closedOn = new Map(closures.map((c) => [c.closed_on, c.reason]));

  const { rows: taken } = await db.query(
    `SELECT starts_at FROM service_bookings
      WHERE location_id = $4 AND status = ANY($1) AND starts_at >= $2 AND starts_at < $3`,
    [LIVE_STATUSES, sastToUtc(firstDay, '00:00'), sastToUtc(addDays(lastDay, 1), '00:00'), Number(locationId)]
  );
  const takenAt = new Set(taken.map((r) => new Date(r.starts_at).getTime()));

  const earliest = new Date(now.getTime() + settings.lead_hours * 60 * 60 * 1000);
  const days = [];
  for (let date = firstDay; date <= lastDay; date = addDays(date, 1)) {
    const times = slotsForWeekday(date, rules);
    const slots = times.map((time) => {
      const startsAt = sastToUtc(date, time);
      let reason = null;
      if (closedOn.has(date)) reason = 'closed';
      else if (takenAt.has(startsAt.getTime())) reason = 'taken';
      else if (startsAt < earliest) reason = 'too_soon';
      return { starts_at: startsAt.toISOString(), time, available: reason === null, reason };
    });
    days.push({
      date,
      weekday: weekdayOf(date),
      closed: closedOn.has(date) || times.length === 0,
      closure_reason: closedOn.get(date) || null,
      slots,
      open_count: slots.filter((s) => s.available).length,
    });
  }

  return { days, settings, location_id: Number(locationId), slot_minutes: SLOT_MINUTES, gap_minutes: GAP_MINUTES };
}

// Is this exact instant a slot the rules actually produce? Without this a
// client could post any timestamp it liked — 09:07 on a Sunday — and the
// unique index would happily accept it, because the index only stops two
// bookings sharing a time, not a time nobody offered.
async function isRealSlot(locationId, startsAt, { scope = {}, db = pgDb } = {}) {
  const at = new Date(startsAt);
  if (Number.isNaN(at.getTime())) return false;
  // A workshop this organisation cannot see is not a workshop it can book,
  // whatever the timestamp says.
  if (!(await locationExists(locationId, { scope, db }))) return false;
  const date = sastDateStr(at);
  const rules = await getRules({ locationId, db });
  if (!slotsForWeekday(date, rules).includes(sastTimeStr(at))) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM service_closures WHERE closed_on = $1 AND location_id = $2', [date, Number(locationId)]);
  return rows.length === 0;
}

// Whether a rider may still move or cancel this booking themselves.
function withinChangeCutoff(startsAt, cutoffHours, now = new Date()) {
  return new Date(startsAt).getTime() - now.getTime() > cutoffHours * 60 * 60 * 1000;
}

module.exports = {
  SLOT_MINUTES, GAP_MINUTES, CADENCE_MINUTES, SAST_OFFSET_MS, LIVE_STATUSES, DEFAULTS, SETTING_KEYS,
  sastToUtc, sastDateStr, sastTimeStr, weekdayOf, addDays, minutesOf, timeStrOf,
  getSettings, setSettings, getRules, replaceRules, getClosures,
  getLocations, locationExists, defaultLocationFor, visibilityClause,
  slotsForWeekday, availability, isRealSlot, withinChangeCutoff,
};
