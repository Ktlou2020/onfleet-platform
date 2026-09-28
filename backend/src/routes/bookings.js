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
const { authRequired, adminOnly, workshopOnly } = require('../middleware/auth');
const asyncRouter = require('../utils/asyncRouter');
const booking = require('../services/serviceBooking');
const { sendNotification } = require('../services/notifierPg');

const router = asyncRouter(express.Router());

const isAdmin = (req) => ['admin', 'superadmin'].includes(req.user.role);

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
  res.json({
    locations: await booking.getLocations(),
    default_location_id: await booking.defaultLocationFor(req.user.id),
  });
});

router.get('/availability', authRequired, async (req, res) => {
  const locationId = Number(req.query.location_id) || await booking.defaultLocationFor(req.user.id);
  try {
    res.json(await booking.availability({
      locationId,
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

  const locationId = Number(req.body.location_id) || await booking.defaultLocationFor(req.user.id);
  if (!(await booking.isRealSlot(locationId, startsAt))) {
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
  const locationId = req.body.location_id != null ? Number(req.body.location_id) : row.location_id;
  if (startsAt && !(await booking.isRealSlot(locationId, startsAt))) {
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
router.get('/day', authRequired, workshopOnly, async (req, res) => {
  const from = req.query.from || booking.sastDateStr(new Date());
  const to = req.query.to || from;
  // No location_id means every workshop. A technician filters to their own;
  // an admin looking at the week wants the lot.
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  const params = [booking.sastToUtc(from, '00:00'), booking.sastToUtc(booking.addDays(to, 1), '00:00')];
  if (locationId) params.push(locationId);

  const { rows } = await pgDb.query(
    `SELECT ${BOOKING_COLUMNS},
            jc.status AS job_card_status,
            (SELECT COUNT(*)::int FROM bike_notes bn
              WHERE bn.bike_id = sb.bike_id AND bn.for_workshop = TRUE AND bn.resolved_at IS NULL) AS open_flags
       ${BOOKING_FROM}
       LEFT JOIN job_cards jc ON jc.id = sb.job_card_id
      WHERE sb.starts_at >= $1 AND sb.starts_at < $2 AND sb.status <> 'cancelled'
        ${locationId ? 'AND sb.location_id = $3' : ''}
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

router.get('/rules', authRequired, workshopOnly, async (req, res) => {
  const locationId = req.query.location_id ? Number(req.query.location_id) : null;
  res.json({
    locations: await booking.getLocations({ activeOnly: false }),
    location_id: locationId,
    rules: await booking.getRules({ locationId }),
    closures: await booking.getClosures({ locationId, from: booking.sastDateStr(new Date()) }),
    settings: await booking.getSettings(),
    slot_minutes: booking.SLOT_MINUTES,
    gap_minutes: booking.GAP_MINUTES,
  });
});

router.put('/rules', authRequired, adminOnly, async (req, res) => {
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

router.post('/closures', authRequired, adminOnly, async (req, res) => {
  const closedOn = String(req.body.closed_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) return res.status(400).json({ error: 'Which date?' });
  const locationId = Number(req.body.location_id);
  if (!(await booking.locationExists(locationId))) return res.status(400).json({ error: 'Which workshop?' });

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
router.post('/locations', authRequired, adminOnly, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const city = String(req.body.city || '').trim().slice(0, 120);
  if (!name || !city) return res.status(400).json({ error: 'A workshop needs a name and a city.' });
  const { rows } = await pgDb.query(
    `INSERT INTO workshop_locations (name, city, province, address, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, city,
      String(req.body.province || '').trim().slice(0, 120) || null,
      String(req.body.address || '').trim().slice(0, 300) || null,
      String(req.body.phone || '').trim().slice(0, 40) || null]);
  res.status(201).json(rows[0]);
});

router.put('/locations/:id', authRequired, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: existing } = await pgDb.query('SELECT id FROM workshop_locations WHERE id = $1', [id]);
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

router.delete('/closures/:id', authRequired, adminOnly, async (req, res) => {
  const { rowCount } = await pgDb.query('DELETE FROM service_closures WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Closure not found' });
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
