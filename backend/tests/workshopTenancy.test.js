import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const booking = createRequire(import.meta.url)('../src/services/serviceBooking.js');
const app = buildApp();

// Whose workshop is it.
//
// workshop_locations was a single global list. Every fleet on the platform
// saw every other fleet's workshops, shared their slots — one fleet booking
// 09:30 took it from another — and could read off how busy a competitor was
// from which times had gone.
//
// None of that is a leak of records, which is why the tenant-isolation tests
// did not catch it: it is a leak through a shared resource. These are the
// tests for that shape of problem.

const dayAhead = (n) => booking.addDays(booking.sastDateStr(new Date()), n);
function nextWednesday() {
  for (let n = 10; n < 20; n += 1) if (booking.weekdayOf(dayAhead(n)) === 3) return dayAhead(n);
  throw new Error('no Wednesday in ten days');
}

describe.skipIf(!process.env.DATABASE_URL)('two fleets, each with its own workshop', () => {
  let rapid, kasi, rapidOwner, kasiOwner, rapidRider, kasiRider, admin, tech;
  let sharedWs, rapidWs, kasiWs, WED;

  const addWorkshop = async (name, orgId) => {
    const { rows } = await pgDb.query(
      `INSERT INTO workshop_locations (name, city, organization_id) VALUES ($1,$2,$3) RETURNING id`,
      [name, 'Johannesburg', orgId]);
    await pgDb.query(
      `INSERT INTO service_slot_rules (weekday, opens_at, closes_at, location_id) VALUES (3,'08:00','12:00',$1)`,
      [rows[0].id]);
    return rows[0].id;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    WED = nextWednesday();

    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    rapidOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    rapidRider = await createPgUser({ role: 'rider', organization_id: rapid.id });
    kasiRider = await createPgUser({ role: 'rider', organization_id: kasi.id });
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });

    const rapidBike = await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id });
    const kasiBike = await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id });
    await createPgAgreement({ bike_id: rapidBike.id, user_id: rapidRider.user.id, status: 'active' });
    await createPgAgreement({ bike_id: kasiBike.id, user_id: kasiRider.user.id, status: 'active' });

    sharedWs = await addWorkshop('Platform Partner', null);
    rapidWs = await addWorkshop('Rapid Own Workshop', rapid.id);
    kasiWs = await addWorkshop('Kasi Own Workshop', kasi.id);
  });

  const locationsFor = (user) => request(app).get('/api/bookings/locations').set(authHeader(user));
  const slot = (time) => booking.sastToUtc(WED, time).toISOString();

  describe('what a fleet can see', () => {
    it('its own workshop and the platform\'s, not the other fleet\'s', async () => {
      const res = await locationsFor(rapidOwner.user);
      const names = res.body.locations.map((l) => l.name).sort();
      expect(names).toEqual(['Platform Partner', 'Rapid Own Workshop']);
    });

    it('and the other fleet sees the mirror image', async () => {
      const res = await locationsFor(kasiOwner.user);
      expect(res.body.locations.map((l) => l.name).sort())
        .toEqual(['Kasi Own Workshop', 'Platform Partner']);
    });

    it('a rider sees the workshops of the fleet whose bike they ride', async () => {
      const res = await locationsFor(rapidRider.user);
      expect(res.body.locations.map((l) => l.name)).toContain('Rapid Own Workshop');
      expect(res.body.locations.map((l) => l.name)).not.toContain('Kasi Own Workshop');
    });

    // The case the fixture above cannot distinguish, because there the rider's
    // own organisation happens to match their bike's. A rider carrying no
    // organisation at all — an OnFleet rider on a fleet's motorcycle — must
    // still be scoped by the bike. Reading req.user.organization_id here
    // yields null, and null used to mean "sees everything".
    it('including a rider who has no organisation of their own', async () => {
      await pgDb.query('UPDATE users SET organization_id = NULL WHERE id = $1', [rapidRider.user.id]);
      const res = await locationsFor(rapidRider.user);
      const names = res.body.locations.map((l) => l.name);
      expect(names, 'a rider with no org saw another fleet\'s workshop').not.toContain('Kasi Own Workshop');
      expect(names).toContain('Rapid Own Workshop');
    });

    // And somebody with no organisation and no motorcycle sees only what the
    // platform offers everybody — not everything.
    it('a rider with no bike at all sees only the shared ones', async () => {
      const stranger = await createPgUser({ role: 'rider', organization_id: null });
      const res = await locationsFor(stranger.user);
      expect(res.body.locations.map((l) => l.name)).toEqual(['Platform Partner']);
    });

    it('platform staff see all of them', async () => {
      const res = await locationsFor(admin.user);
      expect(res.body.locations).toHaveLength(3);
    });
  });

  describe('what a fleet can book', () => {
    const book = (user, locationId, time) =>
      request(app).post('/api/bookings').set(authHeader(user))
        .send({ location_id: locationId, starts_at: slot(time) });

    it('its own workshop', async () => {
      expect((await book(rapidRider.user, rapidWs, '09:30')).status).toBe(201);
    });

    it('and the platform\'s shared one', async () => {
      expect((await book(rapidRider.user, sharedWs, '09:30')).status).toBe(201);
    });

    // Naming another fleet's workshop id directly is the attempt that matters:
    // the list can be filtered and the booking route forgotten.
    it('but not the other fleet\'s, even by naming its id', async () => {
      const res = await book(rapidRider.user, kasiWs, '09:30');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a slot/i);
    });

    it('nor see its availability', async () => {
      const res = await request(app)
        .get(`/api/bookings/availability?location_id=${kasiWs}&from=${WED}&to=${WED}`)
        .set(authHeader(rapidOwner.user));
      expect(res.status).toBe(400);
    });
  });

  // The leak that is not a leak of records: a shared slot.
  describe('slots at a private workshop', () => {
    it('are not taken from one fleet by another booking the same time', async () => {
      await request(app).post('/api/bookings').set(authHeader(rapidRider.user))
        .send({ location_id: rapidWs, starts_at: slot('09:30') });

      const res = await request(app)
        .get(`/api/bookings/availability?location_id=${kasiWs}&from=${WED}&to=${WED}`)
        .set(authHeader(kasiOwner.user));
      expect(res.body.days[0].slots.find((s) => s.time === '09:30').available).toBe(true);
    });

    // And the shared workshop still behaves as one physical workshop, because
    // it is one: two fleets cannot both have 09:30 at the same bay.
    it('but a shared workshop is still one workshop', async () => {
      const first = await request(app).post('/api/bookings').set(authHeader(rapidRider.user))
        .send({ location_id: sharedWs, starts_at: slot('09:30') });
      expect(first.status).toBe(201);

      const second = await request(app).post('/api/bookings').set(authHeader(kasiRider.user))
        .send({ location_id: sharedWs, starts_at: slot('09:30') });
      expect(second.status).toBe(409);
    });
  });

  describe('managing a workshop', () => {
    const create = (user, body) =>
      request(app).post('/api/bookings/locations').set(authHeader(user)).send(body);

    it('a fleet owner can add one, and it is theirs', async () => {
      const res = await create(rapidOwner.user, { name: 'Second Bay', city: 'Pretoria' });
      expect(res.status).toBe(201);
      expect(res.body.organization_id).toBe(rapid.id);
    });

    // Ownership is decided from who is asking, never read from the body.
    it('and cannot place one inside another fleet', async () => {
      const res = await create(rapidOwner.user, {
        name: 'Trojan Bay', city: 'Durban', organization_id: kasi.id,
      });
      expect(res.status).toBe(201);
      expect(res.body.organization_id, 'a fleet placed a workshop in another fleet').toBe(rapid.id);
    });

    it('nor make one the whole platform shares', async () => {
      const res = await create(rapidOwner.user, {
        name: 'Fake Partner', city: 'Cape Town', organization_id: null,
      });
      expect(res.body.organization_id).toBe(rapid.id);
    });

    it('a fleet owner cannot rename another fleet\'s', async () => {
      const res = await request(app).put(`/api/bookings/locations/${kasiWs}`)
        .set(authHeader(rapidOwner.user)).send({ name: 'Mine Now' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT name FROM workshop_locations WHERE id = $1', [kasiWs]);
      expect(rows[0].name).toBe('Kasi Own Workshop');
    });

    // A shared workshop belongs to the platform and every other fleet depends
    // on it. One fleet must not be able to switch it off.
    it('nor touch the platform\'s shared one', async () => {
      const res = await request(app).put(`/api/bookings/locations/${sharedWs}`)
        .set(authHeader(rapidOwner.user)).send({ active: false });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT active FROM workshop_locations WHERE id = $1', [sharedWs]);
      expect(rows[0].active).toBe(true);
    });

    it('but can rename its own', async () => {
      const res = await request(app).put(`/api/bookings/locations/${rapidWs}`)
        .set(authHeader(rapidOwner.user)).send({ name: 'Rapid Main Bay' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Rapid Main Bay');
    });

    it('a platform admin can still place a shared one', async () => {
      const res = await create(admin.user, { name: 'New Partner', city: 'Durban' });
      expect(res.status).toBe(201);
      expect(res.body.organization_id).toBeNull();
    });

    it('a rider can add none at all', async () => {
      expect((await create(rapidRider.user, { name: 'Nope', city: 'X' })).status).toBe(403);
    });
  });

  // Technicians carry no organisation and staff the workshop itself, so they
  // see every booking. That is what makes the day view work at all, and it is
  // a gap worth naming rather than hiding: on a deployment where each fleet
  // owns its workshop, a technician has no fleet to be limited to.
  describe('the workshop floor', () => {
    it('sees bookings at every workshop', async () => {
      await request(app).post('/api/bookings').set(authHeader(rapidRider.user))
        .send({ location_id: rapidWs, starts_at: slot('09:30') });
      await request(app).post('/api/bookings').set(authHeader(kasiRider.user))
        .send({ location_id: kasiWs, starts_at: slot('09:30') });

      const res = await request(app).get(`/api/bookings/day?from=${WED}`).set(authHeader(tech.user));
      expect(res.body.bookings).toHaveLength(2);
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('a platform with only shared workshops', () => {
  // OnFleet's shape: every workshop is the operator's, every fleet uses them.
  // This must not have changed.
  beforeEach(async () => {
    await resetAllPgTables();
    await pgDb.query(
      `INSERT INTO workshop_locations (name, city, province) VALUES ('OnFix','Johannesburg','Gauteng')`);
  });

  it('shows the operator\'s workshop to a fleet that owns none', async () => {
    const org = await createPgOrg({ name: 'Some Fleet', slug: 'some-fleet' });
    await pgDb.query(`UPDATE organizations SET subscription_tier='complete', status='active' WHERE id=$1`, [org.id]);
    const owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });

    const res = await request(app).get('/api/bookings/locations').set(authHeader(owner.user));
    expect(res.body.locations.map((l) => l.name)).toEqual(['OnFix']);
    expect(res.body.default_location_id).toBeTruthy();
  });
});
