import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const booking = createRequire(import.meta.url)('../src/services/serviceBooking.js');
const app = buildApp();

// Two workshops.
//
// OnFix in Johannesburg and Bikerhouse in Cape Town. The calendar shipped
// assuming one, which is the wrong answer for every Cape Town rider rather
// than a rougher version of the right one.
//
// Nearly everything here is about the two not bleeding into each other. The
// expensive direction is capacity: if one booking anywhere holds 09:30, the
// platform silently halves its own bookable hours and reads to riders as
// "fully booked" with nothing anywhere saying why.

const dayAhead = (n) => booking.addDays(booking.sastDateStr(new Date()), n);
function nextWednesday() {
  for (let n = 10; n < 20; n += 1) if (booking.weekdayOf(dayAhead(n)) === 3) return dayAhead(n);
  throw new Error('no Wednesday in ten days');
}

describe.skipIf(!process.env.DATABASE_URL)('two workshops', () => {
  let jhb, cpt, rider, capeRider, tech, admin, bike, capeBike, WED;

  const slot = (time) => booking.sastToUtc(WED, time).toISOString();
  const book = (user, body) => request(app).post('/api/bookings').set(authHeader(user)).send(body);
  const availabilityAt = (user, locationId) =>
    request(app).get(`/api/bookings/availability?location_id=${locationId}&from=${WED}&to=${WED}`).set(authHeader(user));

  beforeEach(async () => {
    await resetAllPgTables();
    WED = nextWednesday();
    const { rows } = await pgDb.query(
      `INSERT INTO workshop_locations (name, city, province) VALUES
         ('OnFix','Johannesburg','Gauteng'), ('Bikerhouse','Cape Town','Western Cape') RETURNING id`);
    jhb = rows[0].id; cpt = rows[1].id;
    await pgDb.query(
      `INSERT INTO service_slot_rules (weekday, opens_at, closes_at, location_id)
       VALUES (3,'08:00','12:00',$1),(3,'08:00','12:00',$2)`, [jhb, cpt]);

    rider = await createPgUser({ role: 'rider' });
    capeRider = await createPgUser({ role: 'rider' });
    tech = await createPgUser({ role: 'technician' });
    admin = await createPgUser({ role: 'superadmin' });

    bike = await createPgBike({ status: 'active', registration: 'GP001' });
    capeBike = await createPgBike({ status: 'active', registration: 'CA001' });
    await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
    await createPgAgreement({ bike_id: capeBike.id, user_id: capeRider.user.id, status: 'active' });
  });

  // The whole reason the unique index had to change.
  describe('the same time at both', () => {
    it('is two bookings, not a clash', async () => {
      const a = await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      const z = await book(capeRider.user, { location_id: cpt, starts_at: slot('09:30') });
      expect(a.status).toBe(201);
      expect(z.status).toBe(201);
      expect(a.body.location_name).toBe('OnFix');
      expect(z.body.location_name).toBe('Bikerhouse');
    });

    it('and Johannesburg filling up does not empty Cape Town', async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });

      const jhbDay = await availabilityAt(rider.user, jhb);
      const cptDay = await availabilityAt(capeRider.user, cpt);
      expect(jhbDay.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(false);
      expect(cptDay.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(true);
    });

    // Still one per bike, though. Booking the same bike into both workshops on
    // one morning is a mistake wherever it happens.
    it('but one bike still cannot be in two places', async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      const res = await book(rider.user, { location_id: cpt, starts_at: slot('10:15') });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already has a booking/i);
    });
  });

  describe('each workshop keeps its own week', () => {
    const putRules = (locationId, rules) =>
      request(app).put('/api/bookings/rules').set(authHeader(admin.user)).send({ location_id: locationId, rules });

    it('saving one does not wipe the other', async () => {
      await putRules(jhb, [{ weekday: 1, opens_at: '07:00', closes_at: '11:00' }]);
      const cptRules = await request(app).get(`/api/bookings/rules?location_id=${cpt}`).set(authHeader(admin.user));
      expect(cptRules.body.rules).toHaveLength(1);
      expect(cptRules.body.rules[0].weekday).toBe(3);
    });

    it('so one can open on a day the other is shut', async () => {
      await putRules(cpt, []); // Bikerhouse takes no bookings at all
      const jhbDay = await availabilityAt(rider.user, jhb);
      const cptDay = await availabilityAt(capeRider.user, cpt);
      expect(jhbDay.body.days[0].open_count).toBeGreaterThan(0);
      expect(cptDay.body.days[0].closed).toBe(true);
    });

    it('refuses a week that names no workshop', async () => {
      const res = await request(app).put('/api/bookings/rules')
        .set(authHeader(admin.user)).send({ rules: [{ weekday: 1, opens_at: '08:00', closes_at: '12:00' }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/which workshop/i);
    });
  });

  describe('closing a day', () => {
    it('closes it at one workshop only', async () => {
      const res = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: jhb, closed_on: WED, reason: 'Stocktake' });
      expect(res.status).toBe(201);

      expect((await availabilityAt(rider.user, jhb)).body.days[0].closed).toBe(true);
      expect((await availabilityAt(capeRider.user, cpt)).body.days[0].closed).toBe(false);
    });

    // Same date, both workshops, independently — the old unique index was on
    // the date alone and would have rejected the second.
    it('and both can be shut on the same public holiday', async () => {
      const a = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: jhb, closed_on: WED, reason: 'Heritage Day' });
      const z = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: cpt, closed_on: WED, reason: 'Heritage Day' });
      expect(a.status).toBe(201);
      expect(z.status).toBe(201);
    });

    it('names only the bookings at that workshop', async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      await book(capeRider.user, { location_id: cpt, starts_at: slot('09:30') });

      const res = await request(app).post('/api/bookings/closures')
        .set(authHeader(admin.user)).send({ location_id: jhb, closed_on: WED });
      expect(res.body.affected_bookings).toHaveLength(1);
      expect(res.body.affected_bookings[0].registration).toBe('GP001');
    });
  });

  // A rider shown the wrong city who does not notice the selector books a slot
  // 1,400 km away, and nobody finds out until the bike fails to arrive.
  describe('which workshop a rider is shown first', () => {
    const defaultFor = async (user) =>
      (await request(app).get('/api/bookings/locations').set(authHeader(user))).body.default_location_id;

    it('follows their province', async () => {
      await pgDb.query(`UPDATE users SET province = 'Western Cape' WHERE id = $1`, [capeRider.user.id]);
      expect(await defaultFor(capeRider.user)).toBe(cpt);
    });

    it('matches regardless of how it was capitalised', async () => {
      await pgDb.query(`UPDATE users SET province = '  western cape ' WHERE id = $1`, [capeRider.user.id]);
      expect(await defaultFor(capeRider.user)).toBe(cpt);
    });

    it('falls back to the first workshop when the province means nothing', async () => {
      await pgDb.query(`UPDATE users SET province = 'Limpopo' WHERE id = $1`, [rider.user.id]);
      expect(await defaultFor(rider.user)).toBe(jhb);
    });

    it('falls back to the first when they have no province at all', async () => {
      expect(await defaultFor(rider.user)).toBe(jhb);
    });

    // Where they actually went last beats where they say they live.
    it('but prefers wherever they last booked', async () => {
      await pgDb.query(`UPDATE users SET province = 'Gauteng' WHERE id = $1`, [rider.user.id]);
      await book(rider.user, { location_id: cpt, starts_at: slot('09:30') });
      expect(await defaultFor(rider.user)).toBe(cpt);
    });

    it('and booking without naming one uses that default', async () => {
      await pgDb.query(`UPDATE users SET province = 'Western Cape' WHERE id = $1`, [capeRider.user.id]);
      const res = await book(capeRider.user, { starts_at: slot('09:30') });
      expect(res.status).toBe(201);
      expect(res.body.location_id).toBe(cpt);
    });

    // A workshop that has been switched off must stop being anybody's default,
    // or riders are quietly sent to a closed door.
    it('never defaults to a workshop that has been switched off', async () => {
      await pgDb.query(`UPDATE users SET province = 'Western Cape' WHERE id = $1`, [capeRider.user.id]);
      await pgDb.query('UPDATE workshop_locations SET active = FALSE WHERE id = $1', [cpt]);
      expect(await defaultFor(capeRider.user)).toBe(jhb);
    });
  });

  describe('moving between workshops', () => {
    let id;
    beforeEach(async () => {
      const res = await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      id = res.body.id;
    });

    it('a rider who picked the wrong city can move the whole booking', async () => {
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ location_id: cpt, starts_at: slot('09:30') });
      expect(res.status).toBe(200);
      expect(res.body.location_name).toBe('Bikerhouse');
    });

    it('and the Johannesburg slot goes back on sale', async () => {
      await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ location_id: cpt, starts_at: slot('09:30') });
      const jhbDay = await availabilityAt(rider.user, jhb);
      expect(jhbDay.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(true);
    });

    // Times are not interchangeable between workshops — they keep separate
    // hours — so changing city without choosing a time would be a guess.
    it('will not change city without a time to go with it', async () => {
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ location_id: cpt });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pick a time/i);
    });

    it('will not move onto a slot the other workshop does not offer', async () => {
      await request(app).put('/api/bookings/rules')
        .set(authHeader(admin.user)).send({ location_id: cpt, rules: [{ weekday: 3, opens_at: '08:00', closes_at: '09:00' }] });
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ location_id: cpt, starts_at: slot('09:30') });
      expect(res.status).toBe(400);
    });

    it('will not move onto a slot the other workshop has already sold', async () => {
      await book(capeRider.user, { location_id: cpt, starts_at: slot('10:15') });
      const res = await request(app).patch(`/api/bookings/${id}`)
        .set(authHeader(rider.user)).send({ location_id: cpt, starts_at: slot('10:15') });
      expect(res.status).toBe(409);
    });
  });

  describe('the workshop day view', () => {
    beforeEach(async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      await book(capeRider.user, { location_id: cpt, starts_at: slot('09:30') });
    });

    it('shows both workshops when none is named', async () => {
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.body.bookings).toHaveLength(2);
    });

    it('and one when it is', async () => {
      const res = await request(app).get(`/api/bookings/day?from=${WED}&location_id=${cpt}`).set(authHeader(tech.user));
      expect(res.body.bookings).toHaveLength(1);
      expect(res.body.bookings[0].registration).toBe('CA001');
    });

    it('naming the workshop on every row, so a mixed day is readable', async () => {
      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.body.bookings.map((b) => b.location_city).sort()).toEqual(['Cape Town', 'Johannesburg']);
    });
  });

  describe('managing the workshops themselves', () => {
    it('an admin can add a third', async () => {
      const res = await request(app).post('/api/bookings/locations')
        .set(authHeader(admin.user)).send({ name: 'Durban Moto', city: 'Durban', province: 'KwaZulu-Natal' });
      expect(res.status).toBe(201);
      expect(res.body.active).toBe(true);
    });

    it('but not one with no city', async () => {
      const res = await request(app).post('/api/bookings/locations')
        .set(authHeader(admin.user)).send({ name: 'Nameless' });
      expect(res.status).toBe(400);
    });

    it('a technician cannot add one', async () => {
      const res = await request(app).post('/api/bookings/locations')
        .set(authHeader(tech.user)).send({ name: 'Durban Moto', city: 'Durban' });
      expect(res.status).toBe(403);
    });

    // Switching a workshop off with bikes booked into it is how riders arrive
    // at a locked gate. It is allowed, but not by accident.
    it('warns before switching one off with bookings still open', async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      const res = await request(app).put(`/api/bookings/locations/${jhb}`)
        .set(authHeader(admin.user)).send({ active: false });
      expect(res.status).toBe(409);
      expect(res.body.affected_bookings).toHaveLength(1);

      const { rows } = await pgDb.query('SELECT active FROM workshop_locations WHERE id = $1', [jhb]);
      expect(rows[0].active).toBe(true); // nothing changed
    });

    it('and goes ahead once that is acknowledged', async () => {
      await book(rider.user, { location_id: jhb, starts_at: slot('09:30') });
      const res = await request(app).put(`/api/bookings/locations/${jhb}`)
        .set(authHeader(admin.user)).send({ active: false, confirm: true });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    // Renaming matters more than it looks: the two seeded workshops are
    // OnFleet's own, and the same migration runs in the Pillion environment,
    // where they are somebody else's business entirely.
    it('an admin can rename one', async () => {
      const res = await request(app).put(`/api/bookings/locations/${cpt}`)
        .set(authHeader(admin.user)).send({ name: 'Cape Bike Works', city: 'Cape Town' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Cape Bike Works');
    });

    it('and that follows through to the bookings already at it', async () => {
      await book(capeRider.user, { location_id: cpt, starts_at: slot('09:30') });
      await request(app).put(`/api/bookings/locations/${cpt}`)
        .set(authHeader(admin.user)).send({ name: 'Cape Bike Works' });
      const res = await request(app).get(`/api/bookings/day?from=${WED}&location_id=${cpt}`).set(authHeader(tech.user));
      expect(res.body.bookings[0].location_name).toBe('Cape Bike Works');
    });

    it('changing the province changes who is sent there', async () => {
      await pgDb.query(`UPDATE users SET province = 'Eastern Cape' WHERE id = $1`, [capeRider.user.id]);
      await request(app).put(`/api/bookings/locations/${cpt}`)
        .set(authHeader(admin.user)).send({ province: 'Eastern Cape' });
      const res = await request(app).get('/api/bookings/locations').set(authHeader(capeRider.user));
      expect(res.body.default_location_id).toBe(cpt);
    });

    it('a technician cannot rename one', async () => {
      const res = await request(app).put(`/api/bookings/locations/${cpt}`)
        .set(authHeader(tech.user)).send({ name: 'Nope' });
      expect(res.status).toBe(403);
    });

    it('switches one off without fuss when nothing is booked', async () => {
      const res = await request(app).put(`/api/bookings/locations/${cpt}`)
        .set(authHeader(admin.user)).send({ active: false });
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    it('and a switched-off workshop stops taking bookings', async () => {
      await pgDb.query('UPDATE workshop_locations SET active = FALSE WHERE id = $1', [cpt]);
      const res = await book(capeRider.user, { location_id: cpt, starts_at: slot('09:30') });
      expect(res.status).toBe(400);
    });

    it('and drops off the list riders choose from', async () => {
      await pgDb.query('UPDATE workshop_locations SET active = FALSE WHERE id = $1', [cpt]);
      const res = await request(app).get('/api/bookings/locations').set(authHeader(rider.user));
      expect(res.body.locations.map((l) => l.city)).toEqual(['Johannesburg']);
    });
  });
});
