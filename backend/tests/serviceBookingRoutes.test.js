import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const booking = createRequire(import.meta.url)('../src/services/serviceBooking.js');
const app = buildApp();

// Booking a service, from the three sides that touch it.
//
// The rider picks a slot, the workshop sees the day, the admin keeps the
// calendar. What each of them may NOT do is most of what is worth testing: a
// rider must not book somebody else's bike, must not invent a time the
// workshop never offered, and must not move a booking the night before.

// A Wednesday far enough out that the 24-hour change cutoff and the two-hour
// lead time are never in the way.
const dayAhead = (n) => booking.addDays(booking.sastDateStr(new Date()), n);

// The first Wednesday at least 10 days out, so "the workshop opens on
// Wednesdays" is the only rule these tests depend on.
function nextWednesday() {
  for (let n = 10; n < 20; n += 1) if (booking.weekdayOf(dayAhead(n)) === 3) return dayAhead(n);
  throw new Error('no Wednesday in ten days — impossible');
}

// Two workshops, because there are two: OnFix in Johannesburg and Bikerhouse
// in Cape Town. Unless a test says otherwise it books at JHB.
const makeLocations = async () => {
  const { rows } = await pgDb.query(
    `INSERT INTO workshop_locations (name, city, province) VALUES
       ('OnFix','Johannesburg','Gauteng'), ('Bikerhouse','Cape Town','Western Cape')
     RETURNING id`);
  return { jhb: rows[0].id, cpt: rows[1].id };
};

describe.skipIf(!process.env.DATABASE_URL)('booking a service', () => {
  let rider, otherRider, tech, admin, bike, WED, jhb, cpt;

  beforeEach(async () => {
    await resetAllPgTables();
    ({ jhb, cpt } = await makeLocations());
    await pgDb.query('DELETE FROM service_slot_rules');
    await pgDb.query(
      `INSERT INTO service_slot_rules (weekday, opens_at, closes_at, location_id) VALUES (3,'08:00','12:00',$1),(3,'08:00','12:00',$2)`,
      [jhb, cpt]);
    WED = nextWednesday();

    rider = await createPgUser({ role: 'rider' });
    otherRider = await createPgUser({ role: 'rider' });
    tech = await createPgUser({ role: 'technician' });
    admin = await createPgUser({ role: 'superadmin' });
    bike = await createPgBike({ status: 'active', registration: 'MJ71MRGP' });
    await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
  });

  const slot = (time) => booking.sastToUtc(WED, time).toISOString();
  const book = (user, body) =>
    request(app).post('/api/bookings').set(authHeader(user)).send({ location_id: jhb, ...body });

  describe('what a rider can do', () => {
    it('takes a slot the workshop offers', async () => {
      const res = await book(rider.user, { starts_at: slot('09:30'), note: 'Front brake squeals' });
      expect(res.status).toBe(201);
      expect(res.body.registration).toBe('MJ71MRGP');
      expect(res.body.status).toBe('booked');
      expect(res.body.note).toBe('Front brake squeals');
    });

    it('sees it on their own page afterwards', async () => {
      await book(rider.user, { starts_at: slot('09:30') });
      const res = await request(app).get('/api/bookings/mine').set(authHeader(rider.user));
      expect(res.status).toBe(200);
      expect(res.body.bike.id).toBe(bike.id);
      expect(res.body.bookings).toHaveLength(1);
    });

    it('and the slot stops being offered to anybody else', async () => {
      await book(rider.user, { starts_at: slot('09:30') });
      const res = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${WED}&to=${WED}`)
        .set(authHeader(otherRider.user));
      const taken = res.body.days[0].slots.find((s) => s.time === '09:30');
      expect(taken.available).toBe(false);
      expect(taken.reason).toBe('taken');
    });

    // The client sends a timestamp, so the client can send any timestamp. The
    // unique index only stops two bookings sharing a time — it has no opinion
    // about 09:07 on a Sunday.
    it('cannot invent a time between slots', async () => {
      const res = await book(rider.user, { starts_at: slot('09:07') });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a slot/i);
    });

    it('cannot book a day the workshop is shut', async () => {
      const sunday = booking.addDays(WED, 4);
      const res = await book(rider.user, { starts_at: booking.sastToUtc(sunday, '09:30').toISOString() });
      expect(res.status).toBe(400);
    });

    it('cannot book a slot that runs past closing time', async () => {
      const res = await book(rider.user, { starts_at: slot('11:45') });
      expect(res.status).toBe(400);
    });

    it('cannot book beyond the horizon the admin set', async () => {
      await booking.setSettings({ horizon_days: 3 });
      const res = await book(rider.user, { starts_at: slot('09:30') });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/3 days ahead/);
    });

    // A rider with no active agreement has no bike, and must not be able to
    // name one in the request body and have it accepted.
    it('cannot book when they have no bike', async () => {
      const res = await book(otherRider.user, { starts_at: slot('09:30'), bike_id: bike.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active agreement/i);
    });

    it('cannot book somebody else\'s bike by naming it', async () => {
      const theirs = await createPgBike({ status: 'active', registration: 'OTHER1' });
      await createPgAgreement({ bike_id: theirs.id, user_id: otherRider.user.id, status: 'active' });
      const res = await book(rider.user, { starts_at: slot('09:30'), bike_id: theirs.id });
      expect(res.status).toBe(201);
      // bike_id in the body was ignored: they booked their own bike.
      expect(res.body.bike_id).toBe(bike.id);
    });

    it('cannot hold two slots at once', async () => {
      await book(rider.user, { starts_at: slot('09:30') });
      const res = await book(rider.user, { starts_at: slot('10:15') });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has a booking/i);
    });
  });

  // The reason the unique index exists rather than a SELECT-then-INSERT.
  describe('two riders reaching for the same slot', () => {
    it('gives it to exactly one of them', async () => {
      const second = await createPgBike({ status: 'active', registration: 'SECOND1' });
      await createPgAgreement({ bike_id: second.id, user_id: otherRider.user.id, status: 'active' });

      const [a, z] = await Promise.all([
        book(rider.user, { starts_at: slot('09:30') }),
        book(otherRider.user, { starts_at: slot('09:30') }),
      ]);

      const codes = [a.status, z.status].sort();
      expect(codes).toEqual([201, 409]);
      const loser = a.status === 409 ? a : z;
      expect(loser.body.error).toMatch(/just took that slot/i);

      const { rows } = await pgDb.query(
        `SELECT COUNT(*)::int n FROM service_bookings WHERE starts_at = $1 AND status = 'booked'`, [slot('09:30')]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('changing a booking', () => {
    let id;
    beforeEach(async () => {
      const res = await book(rider.user, { starts_at: slot('09:30') });
      id = res.body.id;
    });

    it('moves it to another slot', async () => {
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ starts_at: slot('10:15') });
      expect(res.status).toBe(200);
      expect(new Date(res.body.starts_at).toISOString()).toBe(slot('10:15'));
    });

    // Moving must not leave the old slot held. A rider who reschedules three
    // times would otherwise take out a morning.
    it('hands the old slot back', async () => {
      await request(app).patch(`/api/bookings/${id}`).set(authHeader(rider.user)).send({ starts_at: slot('10:15') });
      const res = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${WED}&to=${WED}`).set(authHeader(rider.user));
      expect(res.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(true);
      expect(res.body.days[0].slots.find((s) => s.time === '10:15').available).toBe(false);
    });

    it('cancels it, and frees the slot', async () => {
      const res = await request(app).delete(`/api/bookings/${id}`).set(authHeader(rider.user)).send({ reason: 'Away that week' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      const avail = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${WED}&to=${WED}`).set(authHeader(rider.user));
      expect(avail.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(true);
    });

    it('will not move somebody else\'s booking', async () => {
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(otherRider.user)).send({ starts_at: slot('10:15') });
      // 404 rather than 403: whether that booking exists is not their business.
      expect(res.status).toBe(404);
    });

    it('will not cancel somebody else\'s booking', async () => {
      const res = await request(app).delete(`/api/bookings/${id}`).set(authHeader(otherRider.user));
      expect(res.status).toBe(404);
    });

    it('will not move it onto a slot somebody else has', async () => {
      const second = await createPgBike({ status: 'active', registration: 'SECOND1' });
      await createPgAgreement({ bike_id: second.id, user_id: otherRider.user.id, status: 'active' });
      await book(otherRider.user, { starts_at: slot('10:15') });

      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ starts_at: slot('10:15') });
      expect(res.status).toBe(409);
    });
  });

  describe('once the booking is close', () => {
    // A slot inside the 24-hour cutoff, written straight to the database
    // because the route would refuse to create it.
    const bookCloseBy = async (hoursOut) => {
      const at = new Date(Date.now() + hoursOut * 60 * 60 * 1000);
      const { rows } = await pgDb.query(
        'INSERT INTO service_bookings (bike_id, booked_by, starts_at, location_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [bike.id, rider.user.id, at, jhb]);
      return rows[0].id;
    };

    it('the rider can no longer move it', async () => {
      const id = await bookCloseBy(6);
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ starts_at: slot('10:15') });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/phone the workshop/i);
    });

    it('nor cancel it', async () => {
      const id = await bookCloseBy(6);
      const res = await request(app).delete(`/api/bookings/${id}`).set(authHeader(rider.user));
      expect(res.status).toBe(409);
    });

    // Somebody has to be able to. The cutoff protects the workshop's plan from
    // riders, not from the workshop.
    it('but an admin still can', async () => {
      const id = await bookCloseBy(6);
      const res = await request(app).delete(`/api/bookings/${id}`).set(authHeader(admin.user));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });
  });

  describe('what the workshop sees', () => {
    beforeEach(async () => {
      await book(rider.user, { starts_at: slot('09:30'), note: 'Front brake squeals' });
    });

    it('the day\'s bookings, in order', async () => {
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.status).toBe(200);
      expect(res.body.bookings).toHaveLength(1);
      expect(res.body.bookings[0].registration).toBe('MJ71MRGP');
      expect(res.body.bookings[0].note).toBe('Front brake squeals');
    });

    // The wiring note the control room left on the bike should meet the
    // technician at the booking, not only once the job card is open.
    it('with a count of the flags waiting on that bike', async () => {
      await pgDb.query(
        `INSERT INTO bike_notes (bike_id, note, for_workshop, author_id) VALUES ($1,'Rewire ignition feed',TRUE,$2)`,
        [bike.id, admin.user.id]);
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.body.bookings[0].open_flags).toBe(1);
    });

    it('but a rider cannot read the workshop\'s day', async () => {
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(rider.user));
      expect(res.status).toBe(403);
    });

    it('and a cancelled booking is not on it', async () => {
      const mine = await request(app).get('/api/bookings/mine').set(authHeader(rider.user));
      await request(app).delete(`/api/bookings/${mine.body.bookings[0].id}`).set(authHeader(rider.user));
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.body.bookings).toHaveLength(0);
    });
  });

  describe('when the bike arrives', () => {
    let id;
    beforeEach(async () => {
      const res = await book(rider.user, { starts_at: slot('09:30'), note: 'Front brake squeals' });
      id = res.body.id;
    });

    it('a job card is opened, carrying what the rider said', async () => {
      const res = await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(tech.user));
      expect(res.status).toBe(201);
      expect(res.body.job_card_id).toBeTruthy();

      const { rows } = await pgDb.query('SELECT * FROM job_cards WHERE id = $1', [res.body.job_card_id]);
      expect(rows[0].bike_id).toBe(bike.id);
      expect(rows[0].registration).toBe('MJ71MRGP');
      expect(rows[0].job_type).toBe('service');
      expect(rows[0].status).toBe('open');
      expect(rows[0].description).toMatch(/Front brake squeals/);
    });

    it('and the booking is marked arrived', async () => {
      await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(tech.user));
      const { rows } = await pgDb.query('SELECT status, job_card_id FROM service_bookings WHERE id = $1', [id]);
      expect(rows[0].status).toBe('arrived');
      expect(rows[0].job_card_id).toBeTruthy();
    });

    // Two technicians both clicking "arrived" must not open two job cards for
    // one bike, which is the sort of thing that is only noticed at invoicing.
    it('a second arrival opens no second card', async () => {
      const first = await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(tech.user));
      const again = await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(tech.user));
      expect(again.status).toBe(409);
      expect(again.body.job_card_id).toBe(first.body.job_card_id);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM job_cards WHERE bike_id = $1', [bike.id]);
      expect(rows[0].n).toBe(1);
    });

    it('a rider cannot mark their own bike as arrived', async () => {
      const res = await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(rider.user));
      expect(res.status).toBe(403);
    });

    // An arrived bike still holds its slot — it is in the bay. Only once the
    // slot is freed by cancellation should it be offered again.
    it('the slot is still not offered to anyone else', async () => {
      await request(app).post(`/api/bookings/${id}/arrive`).set(authHeader(tech.user));
      const res = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${WED}&to=${WED}`).set(authHeader(rider.user));
      expect(res.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(false);
    });
  });

  describe('a bike that never turned up', () => {
    it('is recorded as a no-show, not a cancellation', async () => {
      const made = await book(rider.user, { starts_at: slot('09:30') });
      const res = await request(app).post(`/api/bookings/${made.body.id}/no-show`).set(authHeader(tech.user));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('no_show');
    });

    it('and that frees the bike to book again', async () => {
      const made = await book(rider.user, { starts_at: slot('09:30') });
      await request(app).post(`/api/bookings/${made.body.id}/no-show`).set(authHeader(tech.user));
      const again = await book(rider.user, { starts_at: slot('10:15') });
      expect(again.status).toBe(201);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('keeping the calendar', () => {
  let admin, tech, rider, jhb, cpt;

  beforeEach(async () => {
    await resetAllPgTables();
    ({ jhb, cpt } = await makeLocations());
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    rider = await createPgUser({ role: 'rider' });
  });

  const putRules = (user, rules, locationId = jhb) =>
    request(app).put('/api/bookings/rules').set(authHeader(user)).send({ location_id: locationId, rules });

  it('the admin sets the week', async () => {
    const res = await putRules(admin.user, [
      { weekday: 1, opens_at: '08:00', closes_at: '12:00' },
      { weekday: 1, opens_at: '13:00', closes_at: '16:00' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.rules).toHaveLength(2);
  });

  it('a technician may read it but not rewrite it', async () => {
    expect((await request(app).get('/api/bookings/rules').set(authHeader(tech.user))).status).toBe(200);
    expect((await putRules(tech.user, [])).status).toBe(403);
  });

  it('a rider may not even read it', async () => {
    expect((await request(app).get('/api/bookings/rules').set(authHeader(rider.user))).status).toBe(403);
  });

  it('a bad window is refused with a reason a person can act on', async () => {
    const res = await putRules(admin.user, [{ weekday: 1, opens_at: '16:00', closes_at: '08:00' }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ends before it starts/);
  });

  describe('closing a day', () => {
    it('closes it, and stops it being bookable', async () => {
      await putRules(admin.user, [{ weekday: 3, opens_at: '08:00', closes_at: '12:00' }]);
      const wed = nextWednesday();
      const res = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: jhb, closed_on: wed, reason: 'Human Rights Day' });
      expect(res.status).toBe(201);

      const avail = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${wed}&to=${wed}`).set(authHeader(rider.user));
      expect(avail.body.days[0].closed).toBe(true);
      expect(avail.body.days[0].open_count).toBe(0);
    });

    // A public holiday announced late lands on a day that already has bookings.
    // Refusing would be useless; saying nothing would be worse.
    it('names the bookings that now need phoning', async () => {
      await putRules(admin.user, [{ weekday: 3, opens_at: '08:00', closes_at: '12:00' }]);
      const wed = nextWednesday();
      const bike = await createPgBike({ status: 'active', registration: 'AFFECT1' });
      await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
      await request(app).post('/api/bookings').set(authHeader(rider.user))
        .send({ location_id: jhb, starts_at: booking.sastToUtc(wed, '09:30').toISOString() });

      const res = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: jhb, closed_on: wed, reason: 'Burst pipe' });
      expect(res.status).toBe(201);
      expect(res.body.affected_bookings).toHaveLength(1);
      expect(res.body.affected_bookings[0].registration).toBe('AFFECT1');
    });

    it('and reopening it puts the day back', async () => {
      await putRules(admin.user, [{ weekday: 3, opens_at: '08:00', closes_at: '12:00' }]);
      const wed = nextWednesday();
      await request(app).post('/api/bookings/closures').set(authHeader(admin.user)).send({ location_id: jhb, closed_on: wed });
      const { rows } = await pgDb.query('SELECT id FROM service_closures WHERE closed_on = $1', [wed]);
      const gone = await request(app).delete(`/api/bookings/closures/${rows[0].id}`).set(authHeader(admin.user));
      expect(gone.status).toBe(200);

      const avail = await request(app).get(`/api/bookings/availability?location_id=${jhb}&from=${wed}&to=${wed}`).set(authHeader(rider.user));
      expect(avail.body.days[0].closed).toBe(false);
    });

    it('a rider cannot close the workshop', async () => {
      const res = await request(app).post('/api/bookings/closures')
        .set(authHeader(rider.user)).send({ location_id: jhb, closed_on: nextWednesday() });
      expect(res.status).toBe(403);
    });
  });
});
