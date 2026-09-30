'use strict';

// Service bookings: the rider's side, the admin's calendar, and the
// workshop's day.
//
// One router rather than three because all of it is the same small set of
// rows, and splitting by audience is how two of them end up disagreeing about
// what "cancelled" means.
//
// See services/serviceBooking.js for the calendar arithmetic and the
// migration for why slots are generated rather than stored.

const express = require('express');
const pgDb = require('../pgDb');
const { authRequired, adminOnly, workshopOnly, FLEET_OWNER_ROLES } = require('../middleware/auth');
const asyncRouter = require('../utils/asyncRouter');
const booking = require('../services/serviceBooking');
const { sendNotification } = require('../services/notifierPg');
const tierFeatures = require('../services/tierFeatures');

const router = asyncRouter(express.Router());

const isAdmin = (req) => ['admin', 'superadmin'].includes(req.user.role);

/**
 * Whose workshops this request may see.
 *
 * Two separate facts, because conflating them is how a rider with no
 * organisation ended up seeing every fleet's private workshops:
 *
 *   seesAll   platform staff — admins, and technicians, who carry no
 *             organisation and staff the workshop itself.
 *   orgId     the organisation whose workshops these are. For a rider that
 *             is whoever owns the motorcycle, not the rider's own row: on a
 *             fleet's bike the workshop belongs to the fleet. Null here means
 *             shared workshops only, which is the right answer for somebody
 *             with no fleet behind them — not "everything".
 */
async function actingScope(req) {
  if (isAdmin(req) || ['technician', 'control_room'].includes(req.user.role)) {
    return { seesAll: true, orgId: null };
  }
  if (req.user.role === 'rider') {
    const bike = await bikeForRider(req.user.id);
    const orgId = bike ? await bikeOrgId(bike.id) : null;
    return { seesAll: false, orgId: orgId ?? null };
  }
  return { seesAll: false, orgId: req.user.organization_id || null };
}

// May this caller change this workshop's diary?
//
// A platform admin may change any. A fleet owner may change one that belongs
// to them — not a shared one, because every other fleet books into it, and
// obviously not another fleet's.
//
// Returns a reason rather than a boolean so the caller can answer with the
// right status: 404 for a workshop that is not theirs (whether somebody
// else's exists is not their business) and 403 for a plan that does not
// include running one.
// Whether this fleet's plan includes running a workshop of their own, with no
// workshop named yet. Adding one and operating one have to agree: a fleet that
// may create a workshop but not set its hours has been sold a trap.
async function mayRunOwnWorkshop(req) {
  if (isAdmin(req)) return { ok: true };
  if (!FLEET_OWNER_ROLES.includes(req.user.role)) return { ok: false, status: 403, error: 'Not allowed' };

  const { rows: org } = await pgDb.query(
    'SELECT status, subscription_tier FROM organizations WHERE id = $1', [req.user.organization_id]);
  const tier = tierFeatures.effectiveTier(org[0]);
  if (!tierFeatures.tierAllows(tier, 'workshop')) {
    return {
      ok: false,
      status: 403,
      error: `Running your own workshop is part of the ${tierFeatures.minimumTierFor('workshop')} plan.`,
      code: 'TIER_REQUIRED',
      current_tier: tier,
      required_tier: tierFeatures.minimumTierFor('workshop'),
    };
  }
  return { ok: true };
}

async function mayManageLocation(req, locationId) {
  const plan = await mayRunOwnWorkshop(req);
  if (!plan.ok) return plan;
  if (isAdmin(req)) return { ok: true };

  const { rows } = await pgDb.query(
    'SELECT 1 FROM workshop_locations WHERE id = $1 AND organization_id = $2',
    [Number(locationId), req.user.organization_id]);
  if (!rows[0]) return { ok: false, status: 404, error: 'Workshop not found' };
  return { ok: true };
}

function refuse(res, verdict) {
  const { status, ok, ...body } = verdict;
  return res.status(status).json(body);
}

async function bikeOrgId(bikeId) {
  const { rows } = await pgDb.query('SELECT organization_id FROM bikes WHERE id = $1', [bikeId]);
  return rows[0]?.organization_id ?? null;
}

// Postgres raises 23505 when a partial unique index rejects a row. Two of them
// guard this table and they mean quite different things to the person who hit
// them, so the message depends on which one fired.
const SLOT_TAKEN = 'service_bookings_one_bike_per_slot';
const BIKE_BUSY = 'service_bookings_one_live_per_bike';

function bookingConflict(err) {
  if (err.code !== '23505') return null;
  if (String(err.constraint) === SLOT_TAKEN) {
    return { status: 409, error: 'Somebody just took that slot. Please pick another.' };
  }
  if (String(err.constraint) === BIKE_BUSY) {
    return { status: 409, error: 'That bike already has a booking. Change the existing one instead.' };
  }
  return { status: 409, error: 'That booking clashes with one already made.' };
}

const BOOKING_COLUMNS = `
  sb.id, sb.bike_id, sb.starts_at, sb.status, sb.note, sb.job_card_id,
  sb.cancelled_at, sb.cancel_reason, sb.created_at,
  b.registration, b.make, b.model, b.odometer_km,
  o.name AS organization_name,
  u.full_name AS booked_by_name,
  sb.location_id, wl.name AS location_name, wl.city AS location_city`;

const BOOKING_FROM = `
  FROM service_bookings sb
  JOIN bikes b ON b.id = sb.bike_id
  LEFT JOIN organizations o ON o.id = b.organization_id
  LEFT JOIN users u ON u.id = sb.booked_by
  JOIN workshop_locations wl ON wl.id = sb.location_id`;

// A rider's bike is the one on their active agreement. Riders do not own bikes
// in this schema; they rent one at a time.
async function bikeForRider(userId) {
  const { rows } = await pgDb.query(
    `SELECT b.id, b.registration, b.make, b.model, b.odometer_km, b.next_service_date, b.next_service_km
       FROM agreements a JOIN bikes b ON b.id = a.bike_id
      WHERE a.user_id = $1 AND a.status = 'active'
      ORDER BY a.id DESC LIMIT 1`, [userId]);
  return rows[0] || null;
}

// ------------------------------------------------------------ calendar ----

// What is free. Riders and the workshop both read this; a rider gets the
// horizon clamp, the workshop does not, because it needs to see its own diary
// further out than a rider may book into.
// The workshops, and which one this person should be shown first.
router.get('/locations', authRequired, async (req, res) => {
  const scope = await actingScope(req);
  // A rider is offered the workshops that are open, which is the default.
  // Somebody managing workshops needs the switched-off ones too, or a
  // workshop they closed has no screen on which to reopen it. For a fleet
  // owner that means their own closed ones only — a shared workshop the
  // platform has switched off is not theirs to reopen, so it stays hidden.
  const wantsInactive = req.query.include_inactive === '1';
  const manages = wantsInactive && (isAdmin(req) || FLEET_OWNER_ROLES.includes(req.user.role));
  res.json({
    locations: await booking.getLocations({
      scope,
      activeOnly: !(manages && isAdmin(req)),
      inactiveOwnerId: manages && !isAdmin(req) ? req.user.organization_id : null,
    }),
    default_location_id: await booking.defaultLocationFor(req.user.id, { scope }),
  });
});

router.get('/availability', authRequired, async (req, res) => {
  const scope = await actingScope(req);
  const locationId = Number(req.query.location_id) || await booking.defaultLocationFor(req.user.id, { scope });
  try {
    res.json(await booking.availability({
      locationId,
      scope,
      from: req.query.from || null,
      to: req.query.to || null,
      ignoreHorizon: isAdmin(req) && req.query.all === '1',
    }));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// ------------------------------------------------------- the rider side ----

router.get('/mine', authRequired, async (req, res) => {
  const bike = await bikeForRider(req.user.id);
  if (!bike) return res.json({ bike: null, bookings: [], due: null });

  const { rows } = await pgDb.query(
    `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM}
      WHERE sb.bike_id = $1 ORDER BY sb.starts_at DESC LIMIT 20`, [bike.id]);

  // The same classification the workshop's own "due for service" list uses, so
  // a rider is told they are overdue in the same words and on the same rule.
  const { classify } = require('../services/serviceDue');
  const kmRemaining = bike.next_service_km != null && bike.odometer_km != null
    ? Number(bike.next_service_km) - Number(bike.odometer_km) : null;
  const daysRemaining = bike.next_service_date
    ? Math.round((new Date(bike.next_service_date) - new Date()) / 86400000) : null;

  res.json({
    bike,
    bookings: rows,
    due: { state: classify({ kmRemaining, daysRemaining }), km_remaining: kmRemaining, days_remaining: daysRemaining },
    settings: await booking.getSettings(),
  });
});

router.post('/', authRequired, async (req, res) => {
  const startsAt = req.body.starts_at;
  const note = String(req.body.note || '').trim().slice(0, 1000) || null;

  // A rider may only ever book the bike they are riding. An admin may book any
  // bike, including a walk-in the workshop registered this morning.
  let bikeId;
  if (isAdmin(req) && req.body.bike_id) {
    bikeId = Number(req.body.bike_id);
    const { rows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [bikeId]);
    if (!rows[0]) return res.status(404).json({ error: 'Bike not found' });
  } else {
    const bike = await bikeForRider(req.user.id);
    if (!bike) return res.status(400).json({ error: 'You do not have a bike on an active agreement.' });
    bikeId = bike.id;
  }

  const scope = await actingScope(req);
  const locationId = Number(req.body.location_id) || await booking.defaultLocationFor(req.user.id, { scope });
  if (!(await booking.isRealSlot(locationId, startsAt, { scope }))) {
    return res.status(400).json({ error: 'That is not a slot the workshop offers.' });
  }

  // The lead time applies to riders. An admin taking a booking over the phone
  // for later this morning is the case it would otherwise get in the way of.
  if (!isAdmin(req)) {
    const settings = await booking.getSettings();
    const earliest = new Date(Date.now() + settings.lead_hours * 60 * 60 * 1000);
    if (new Date(startsAt) < earliest) {
      return res.status(400).json({ error: `Bookings need at least ${settings.lead_hours} hours' notice.` });
    }
    const horizonEnd = booking.sastToUtc(booking.addDays(booking.sastDateStr(new Date()), settings.horizon_days + 1), '00:00');
    if (new Date(startsAt) >= horizonEnd) {
      return res.status(400).json({ error: `You can book up to ${settings.horizon_days} days ahead.` });
    }
  }

  try {
    const { rows } = await pgDb.query(
      `INSERT INTO service_bookings (bike_id, booked_by, starts_at, note, location_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [bikeId, req.user.id, startsAt, note, locationId]);
    const created = await loadBooking(rows[0].id);
    notifyBooked(created).catch(() => {});
    res.status(201).json(created);
  } catch (err) {
    const clash = bookingConflict(err);
    if (clash) return res.status(clash.status).json({ error: clash.error });
    throw err;
  }
});

async function loadBooking(id) {
  const { rows } = await pgDb.query(`SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE sb.id = $1`, [id]);
  return rows[0] || null;
}

// Can this person touch this booking at all?
async function bookingFor(req, id) {
  const row = await loadBooking(Number(id));
  if (!row) return { error: { status: 404, message: 'Booking not found' } };
  if (isAdmin(req) || ['technician'].includes(req.user.role)) return { row };
  const bike = await bikeForRider(req.user.id);
  if (!bike || bike.id !== row.bike_id) return { error: { status: 404, message: 'Booking not found' } };
  return { row };
}

// Moving a booking, rather than cancelling and re-booking, so the bike never
// lets go of a slot it is going to want back and the history stays one row.
router.patch('/:id', authRequired, async (req, res) => {
  const { row, error } = await bookingFor(req, req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
  if (!booking.LIVE_STATUSES.includes(row.status)) {
    return res.status(409).json({ error: `That booking is already ${row.status}.` });
  }

  const settings = await booking.getSettings();
  if (!isAdmin(req) && !booking.withinChangeCutoff(row.starts_at, settings.change_cutoff_hours)) {
    return res.status(409).json({
      error: `Bookings can only be changed more than ${settings.change_cutoff_hours} hours ahead. Please phone the workshop.`,
    });
  }

  const startsAt = req.body.starts_at;
  // A rider who picked the wrong city can move the booking to the other
  // workshop, which is the same operation as moving the time.
  const scope = await actingScope(req);
  const locationId = req.body.location_id != null ? Number(req.body.location_id) : row.location_id;
  if (startsAt && !(await booking.isRealSlot(locationId, startsAt, { scope }))) {
    return res.status(400).json({ error: 'That is not a slot the workshop offers.' });
  }
  if (!startsAt && locationId !== row.location_id) {
    return res.status(400).json({ error: 'Pick a time at the other workshop as well.' });
  }

  try {
    await pgDb.query(
      `UPDATE service_bookings
          SET starts_at = COALESCE($1, starts_at),
              note = COALESCE($2, note),
              location_id = $4,
              updated_at = NOW()
        WHERE id = $3`,
      [startsAt || null, req.body.note != null ? String(req.body.note).slice(0, 1000) : null, row.id, locationId]);
    res.json(await loadBooking(row.id));
  } catch (err) {
    const clash = bookingConflict(err);
    if (clash) return res.status(clash.status).json({ error: clash.error });
    throw err;
  }
});

router.delete('/:id', authRequired, async (req, res) => {
  const { row, error } = await bookingFor(req, req.params.id);
  if (error) return res.status(error.status).json({ error: error.message });
  if (!booking.LIVE_STATUSES.includes(row.status)) {
    return res.status(409).json({ error: `That booking is already ${row.status}.` });
  }

  const settings = await booking.getSettings();
  if (!isAdmin(req) && !booking.withinChangeCutoff(row.starts_at, settings.change_cutoff_hours)) {
    return res.status(409).json({
      error: `Bookings can only be cancelled more than ${settings.change_cutoff_hours} hours ahead. Please phone the workshop.`,
    });
  }

  // Cancelled rather than deleted: the slot is freed by the partial index, and
  // a workshop planning its week wants to know a booking was made and dropped.
  await pgDb.query(
    `UPDATE service_bookings
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, cancel_reason = $2, updated_at = NOW()
      WHERE id = $3`,
    [req.user.id, String(req.body?.reason || '').slice(0, 500) || null, row.id]);
  res.json(await loadBooking(row.id));
});

// --------------------------------------------------- the workshop's day ----

// Everything booked in a date range, for the workshop's diary and the admin's
// oversight tab. Defaults to today.
router.get('/day', authRequired, async (req, res) => {
  const from = req.query.from || booking.sastDateStr(new Date());
  const to = req.query.to || from;
  // No location_id means every workshop. A technician filters to their own;
  // an admin looking at the week wants the lot.
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  const params = [booking.sastToUtc(from, '00:00'), booking.sastToUtc(booking.addDays(to, 1), '00:00')];

  // A fleet owner sees their own workshops' diaries and nothing else. Naming
  // one they do not own is refused rather than quietly returning empty, so a
  // mistake is visible instead of looking like a quiet day.
  let ownerScope = '';
  if (!isAdmin(req) && !['technician', 'control_room'].includes(req.user.role)) {
    if (!FLEET_OWNER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    if (locationId) {
      const verdict = await mayManageLocation(req, locationId);
      if (!verdict.ok) return refuse(res, verdict);
    } else {
      params.push(req.user.organization_id);
      ownerScope = `AND wl.organization_id = $${params.length}`;
    }
  }
  if (locationId) params.push(locationId);

  const { rows } = await pgDb.query(
    `SELECT ${BOOKING_COLUMNS},
            jc.status AS job_card_status,
            (SELECT COUNT(*)::int FROM bike_notes bn
              WHERE bn.bike_id = sb.bike_id AND bn.for_workshop = TRUE AND bn.resolved_at IS NULL) AS open_flags
       ${BOOKING_FROM}
       LEFT JOIN job_cards jc ON jc.id = sb.job_card_id
      WHERE sb.starts_at >= $1 AND sb.starts_at < $2 AND sb.status <> 'cancelled'
        ${ownerScope}
        ${locationId ? `AND sb.location_id = $${params.length}` : ''}
      ORDER BY sb.starts_at, wl.id`, params);
  res.json({ from, to, location_id: locationId, bookings: rows });
});

// The bike turned up. This is where a job card is born — not at booking time,
// because an open job card should mean work that is actually happening.
router.post('/:id/arrive', authRequired, workshopOnly, async (req, res) => {
  const row = await loadBooking(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  if (row.job_card_id) {
    return res.status(409).json({ error: 'That booking already has a job card.', job_card_id: row.job_card_id });
  }
  if (row.status !== 'booked') {
    return res.status(409).json({ error: `That booking is ${row.status}.` });
  }

  const { rows: bikeRows } = await pgDb.query(
    'SELECT id, vin, registration, make, model, year, color, engine_cc, organization_id FROM bikes WHERE id = $1',
    [row.bike_id]);
  const bike = bikeRows[0];
  const { rows: orgRows } = bike.organization_id
    ? await pgDb.query('SELECT name FROM organizations WHERE id = $1', [bike.organization_id])
    : { rows: [] };

  // The rider's own description of the fault carries over, so the technician
  // reads what the rider said rather than "Booked service".
  const description = row.note
    ? `Booked service — ${row.note}`
    : 'Booked service';

  const created = await pgDb.withTransaction(async (tx) => {
    const { rows: jc } = await tx.query(
      `INSERT INTO job_cards (bike_id, vin, registration, make, model, year, color, engine_cc,
                              fleet_owner_name, fleet_org_id, job_type, description, status, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'service',$11,'open','normal',$12) RETURNING id`,
      [bike.id, bike.vin, bike.registration, bike.make, bike.model, bike.year, bike.color, bike.engine_cc,
        orgRows[0]?.name || null, bike.organization_id || null, description, req.user.id]);
    await tx.query(
      `UPDATE service_bookings SET status = 'arrived', job_card_id = $1, updated_at = NOW() WHERE id = $2`,
      [jc[0].id, row.id]);
    return jc[0].id;
  });

  res.status(201).json({ ...(await loadBooking(row.id)), job_card_id: created });
});

// The bike never came. Keeping this distinct from a cancellation is the whole
// point: a no-show is a fact about a rider, and a workshop deciding whether to
// keep offering same-week slots needs to be able to count them.
router.post('/:id/no-show', authRequired, workshopOnly, async (req, res) => {
  const row = await loadBooking(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  if (row.status !== 'booked') return res.status(409).json({ error: `That booking is ${row.status}.` });
  await pgDb.query(`UPDATE service_bookings SET status = 'no_show', updated_at = NOW() WHERE id = $1`, [row.id]);
  res.json(await loadBooking(row.id));
});

// --------------------------------------------------- the admin's calendar ----

router.get('/rules', authRequired, async (req, res) => {
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  // Platform staff read the whole diary. A fleet owner reads their own
  // workshop's, and only once they can point at which one.
  //
  // Who is asking is settled before which workshop, so a rider is told they
  // may not read the calendar rather than being asked which one they meant.
  if (!isAdmin(req) && req.user.role !== 'technician') {
    const plan = await mayRunOwnWorkshop(req);
    if (!plan.ok) return refuse(res, plan);
    if (!locationId) return res.status(400).json({ error: 'Which workshop?' });
    const verdict = await mayManageLocation(req, locationId);
    if (!verdict.ok) return refuse(res, verdict);
  }
  const scope = await actingScope(req);
  res.json({
    locations: await booking.getLocations({ scope, activeOnly: false }),
    location_id: locationId,
    rules: await booking.getRules({ locationId }),
    closures: await booking.getClosures({ locationId, from: booking.sastDateStr(new Date()) }),
    settings: await booking.getSettings(),
    slot_minutes: booking.SLOT_MINUTES,
    gap_minutes: booking.GAP_MINUTES,
  });
});

router.put('/rules', authRequired, async (req, res) => {
  const verdict = await mayManageLocation(req, Number(req.body.location_id));
  if (!verdict.ok) return refuse(res, verdict);
  try {
    const rules = await booking.replaceRules(Number(req.body.location_id), req.body.rules || [], req.user.id);
    res.json({ rules });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});

router.put('/settings', authRequired, adminOnly, async (req, res) => {
  res.json({ settings: await booking.setSettings(req.body || {}) });
});

router.post('/closures', authRequired, async (req, res) => {
  const closedOn = String(req.body.closed_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) return res.status(400).json({ error: 'Which date?' });
  const locationId = Number(req.body.location_id);
  const verdict = await mayManageLocation(req, locationId);
  if (!verdict.ok) return refuse(res, verdict);
  // Existence only — mayManageLocation above has already settled whose it is.
  if (!(await booking.locationExists(locationId, { scope: { seesAll: true } }))) {
    return res.status(400).json({ error: 'Which workshop?' });
  }

  // Closing a day with bookings already on it is allowed — public holidays get
  // announced late — but the admin is told exactly who needs phoning rather
  // than finding out when the bikes arrive.
  const { rows: affected } = await pgDb.query(
    `SELECT sb.id, sb.starts_at, b.registration
       FROM service_bookings sb JOIN bikes b ON b.id = sb.bike_id
      WHERE sb.location_id = $4 AND sb.status = ANY($1)
        AND sb.starts_at >= $2 AND sb.starts_at < $3 ORDER BY sb.starts_at`,
    [booking.LIVE_STATUSES, booking.sastToUtc(closedOn, '00:00'), booking.sastToUtc(booking.addDays(closedOn, 1), '00:00'), locationId]);

  await pgDb.query(
    `INSERT INTO service_closures (closed_on, reason, created_by, location_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (location_id, closed_on) DO UPDATE SET reason = EXCLUDED.reason`,
    [closedOn, String(req.body.reason || '').slice(0, 200) || null, req.user.id, locationId]);

  res.status(201).json({ closed_on: closedOn, location_id: locationId, affected_bookings: affected });
});

// Adding a third workshop should be a row an admin types, not a migration.
// Adding a workshop. Two callers with different rights:
//
//   a platform admin   may add one for everybody (no owner) or for a named
//                      fleet — they run the platform and place both kinds.
//   a fleet owner      may add one, and it is theirs. They cannot make a
//                      shared workshop and cannot place one in somebody
//                      else's fleet, whatever they put in the body.
router.post('/locations', authRequired, async (req, res) => {
  if (!isAdmin(req) && !FLEET_OWNER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an admin or a fleet owner can add a workshop' });
  }
  // Gated on the plan for the same reason the hours are: a workshop whose
  // hours cannot be set takes no bookings, so letting one be created on a
  // plan that cannot operate it only produces a dead row and a support call.
  const plan = await mayRunOwnWorkshop(req);
  if (!plan.ok) return refuse(res, plan);

  // The ownership is decided here, from who is asking, and never read from
  // the request for a fleet owner. Taking it from the body would let one
  // fleet place a workshop inside another's account.
  const ownerOrgId = isAdmin(req)
    ? (req.body.organization_id != null ? Number(req.body.organization_id) : null)
    : req.user.organization_id;

  if (!isAdmin(req) && !ownerOrgId) {
    return res.status(400).json({ error: 'Your account is not attached to a fleet.' });
  }

  const name = String(req.body.name || '').trim().slice(0, 120);
  const city = String(req.body.city || '').trim().slice(0, 120);
  if (!name || !city) return res.status(400).json({ error: 'A workshop needs a name and a city.' });
  const { rows } = await pgDb.query(
    `INSERT INTO workshop_locations (name, city, province, address, phone, organization_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, city,
      String(req.body.province || '').trim().slice(0, 120) || null,
      String(req.body.address || '').trim().slice(0, 300) || null,
      String(req.body.phone || '').trim().slice(0, 40) || null,
      ownerOrgId || null]);
  res.status(201).json(rows[0]);
});

router.put('/locations/:id', authRequired, async (req, res) => {
  if (!isAdmin(req) && !FLEET_OWNER_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an admin or a fleet owner can change a workshop' });
  }
  const id = Number(req.params.id);

  // A fleet owner may only touch a workshop that is theirs. Not a shared one
  // — that belongs to the platform and every other fleet depends on it — and
  // obviously not another fleet's. 404 rather than 403: whether somebody
  // else's workshop exists is not their business.
  const scope = isAdmin(req)
    ? { clause: '', params: [id] }
    : { clause: 'AND organization_id = $2', params: [id, req.user.organization_id] };
  const { rows: existing } = await pgDb.query(
    `SELECT id FROM workshop_locations WHERE id = $1 ${scope.clause}`, scope.params);
  if (!existing[0]) return res.status(404).json({ error: 'Workshop not found' });

  // Closing a workshop must not strand bikes already booked into it. They are
  // named back so somebody can phone them, the same as closing a single day.
  if (req.body.active === false) {
    const { rows: stranded } = await pgDb.query(
      `SELECT sb.id, sb.starts_at, b.registration
         FROM service_bookings sb JOIN bikes b ON b.id = sb.bike_id
        WHERE sb.location_id = $1 AND sb.status = ANY($2) AND sb.starts_at >= NOW()
        ORDER BY sb.starts_at`, [id, booking.LIVE_STATUSES]);
    if (stranded.length && req.body.confirm !== true) {
      return res.status(409).json({
        error: `${stranded.length} booking${stranded.length === 1 ? '' : 's'} still open at this workshop.`,
        affected_bookings: stranded,
      });
    }
  }

  const { rows } = await pgDb.query(
    `UPDATE workshop_locations SET
        name = COALESCE($2, name), city = COALESCE($3, city), province = COALESCE($4, province),
        address = COALESCE($5, address), phone = COALESCE($6, phone), active = COALESCE($7, active)
      WHERE id = $1 RETURNING *`,
    [id,
      req.body.name != null ? String(req.body.name).trim().slice(0, 120) : null,
      req.body.city != null ? String(req.body.city).trim().slice(0, 120) : null,
      req.body.province != null ? String(req.body.province).trim().slice(0, 120) : null,
      req.body.address != null ? String(req.body.address).trim().slice(0, 300) : null,
      req.body.phone != null ? String(req.body.phone).trim().slice(0, 40) : null,
      typeof req.body.active === 'boolean' ? req.body.active : null]);
  res.json(rows[0]);
});

router.delete('/closures/:id', authRequired, async (req, res) => {
  // Which workshop's closure this is decides who may remove it, so it has to
  // be looked up before the delete rather than after.
  const { rows } = await pgDb.query(
    'SELECT location_id FROM service_closures WHERE id = $1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'Closure not found' });
  const verdict = await mayManageLocation(req, rows[0].location_id);
  if (!verdict.ok) return refuse(res, verdict);

  await pgDb.query('DELETE FROM service_closures WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ------------------------------------------------------------ plumbing ----

// Confirmation to whoever is riding the bike. Best-effort: a booking that was
// made must not fail because an SMS gateway is down.
async function notifyBooked(row) {
  if (!row) return;
  const { rows } = await pgDb.query(
    `SELECT user_id FROM agreements WHERE bike_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [row.bike_id]);
  if (!rows[0]?.user_id) return;
  const when = new Date(row.starts_at).toLocaleString('en-ZA', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Johannesburg',
  });
  await sendNotification({
    userId: rows[0].user_id,
    channel: 'in_app',
    type: 'service_booking',
    title: 'Service booked',
    message: `${row.registration} is booked in at ${row.location_name} (${row.location_city}) for ${when}.`,
    entityType: 'service_booking',
    entityId: row.id,
  });
}

module.exports = router;
