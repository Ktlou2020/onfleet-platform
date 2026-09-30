import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Whose work a mechanic sees.
//
// Technicians have always seen every job card and every workshop's diary.
// On OnFleet that is right — OnFleet owns the workshops and services every
// fleet's motorcycles at them, so there is one floor. These tests pin that
// behaviour down, because the fix for the other shape must not disturb it.
//
// The other shape is a fleet running its own workshop with its own mechanics,
// where "sees everything" means one fleet's mechanic reading another's
// bookings and job cards. That is tested in the telematics file, where the
// brand makes a platform technician somebody with no workshop to be in.

describe.skipIf(!process.env.DATABASE_URL)('workshop staff on a deployment that runs its own workshops', () => {
  let rapid, kasi, floorTech, rapidTech, rapidBike, kasiBike, sharedWs, rapidWs, kasiWs;

  const addWorkshop = async (name, orgId) => {
    const { rows } = await pgDb.query(
      `INSERT INTO workshop_locations (name, city, organization_id) VALUES ($1,'Johannesburg',$2) RETURNING id`,
      [name, orgId]);
    return rows[0].id;
  };

  const jobCardFor = async (bike, orgId) => {
    const { rows } = await pgDb.query(
      `INSERT INTO job_cards (bike_id, registration, job_type, description, status, fleet_org_id)
       VALUES ($1,$2,'service','Service due','open',$3) RETURNING id`,
      [bike.id, bike.registration, orgId]);
    return rows[0].id;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    // The platform's own mechanic: no fleet, the whole floor.
    floorTech = await createPgUser({ role: 'technician' });
    // A fleet's own mechanic.
    rapidTech = await createPgUser({ role: 'technician', organization_id: rapid.id });

    rapidBike = await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id });
    kasiBike = await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id });

    sharedWs = await addWorkshop('Platform Partner', null);
    rapidWs = await addWorkshop('Rapid Own Bay', rapid.id);
    kasiWs = await addWorkshop('Kasi Own Bay', kasi.id);
  });

  // The behaviour OnFleet depends on, and the reason this is safe to land:
  // every technician that exists today has no fleet.
  describe('a technician belonging to nobody', () => {
    it('sees every workshop', async () => {
      const res = await request(app).get('/api/bookings/locations').set(authHeader(floorTech.user));
      expect(res.body.locations.map((l) => l.name).sort())
        .toEqual(['Kasi Own Bay', 'Platform Partner', 'Rapid Own Bay']);
    });

    it('and every fleet\'s job cards', async () => {
      await jobCardFor(rapidBike, rapid.id);
      await jobCardFor(kasiBike, kasi.id);
      const res = await request(app).get('/api/workshop/job-cards').set(authHeader(floorTech.user));
      expect(res.body.job_cards).toHaveLength(2);
    });

    it('and can open either of them', async () => {
      const kasiCard = await jobCardFor(kasiBike, kasi.id);
      const res = await request(app).get(`/api/workshop/job-cards/${kasiCard}`).set(authHeader(floorTech.user));
      expect(res.status).toBe(200);
    });
  });

  describe('a mechanic belonging to a fleet', () => {
    it('sees that fleet\'s workshop, and not the other fleet\'s', async () => {
      const res = await request(app).get('/api/bookings/locations').set(authHeader(rapidTech.user));
      const names = res.body.locations.map((l) => l.name);
      expect(names).toContain('Rapid Own Bay');
      expect(names, 'a mechanic saw another fleet\'s workshop').not.toContain('Kasi Own Bay');
    });

    // Not "theirs or the platform's": the shared workshop is staffed by the
    // platform's own people, and its diary is not this mechanic's work.
    it('nor the workshop the platform runs for everybody', async () => {
      const res = await request(app).get('/api/bookings/locations').set(authHeader(rapidTech.user));
      expect(res.body.locations.map((l) => l.name)).not.toContain('Platform Partner');
    });

    it('sees their own fleet\'s job cards only', async () => {
      await jobCardFor(rapidBike, rapid.id);
      await jobCardFor(kasiBike, kasi.id);
      const res = await request(app).get('/api/workshop/job-cards').set(authHeader(rapidTech.user));
      expect(res.body.job_cards).toHaveLength(1);
      expect(res.body.job_cards[0].display_registration).toBe('RAP001GP');
    });

    it('and cannot open another fleet\'s by its number', async () => {
      const kasiCard = await jobCardFor(kasiBike, kasi.id);
      const res = await request(app).get(`/api/workshop/job-cards/${kasiCard}`).set(authHeader(rapidTech.user));
      expect(res.status).toBe(404);
    });

    // The id is the door for fourteen routes, so the guard is in front of all
    // of them rather than in each.
    it('nor work on it', async () => {
      const kasiCard = await jobCardFor(kasiBike, kasi.id);
      const start = await request(app).post(`/api/workshop/job-cards/${kasiCard}/start`).set(authHeader(rapidTech.user));
      expect(start.status).toBe(404);
      const items = await request(app).post(`/api/workshop/job-cards/${kasiCard}/items`)
        .set(authHeader(rapidTech.user)).send({ description: 'Not my bike', quantity: 1, unit_cost: 100 });
      expect(items.status).toBe(404);

      const { rows } = await pgDb.query('SELECT status FROM job_cards WHERE id = $1', [kasiCard]);
      expect(rows[0].status, 'a mechanic started work on another fleet\'s bike').toBe('open');
    });

    it('but works on their own perfectly well', async () => {
      const own = await jobCardFor(rapidBike, rapid.id);
      const res = await request(app).post(`/api/workshop/job-cards/${own}/start`).set(authHeader(rapidTech.user));
      expect(res.status).toBe(200);
    });
  });

  describe('the diary', () => {
    let rider;

    beforeEach(async () => {
      rider = await createPgUser({ role: 'rider', organization_id: rapid.id });
      await createPgAgreement({ bike_id: rapidBike.id, user_id: rider.user.id, status: 'active' });
      // A third motorcycle for the shared workshop: one live booking per bike
      // is enforced by an index, so the same bike cannot sit in two bays.
      const spare = await createPgBike({ registration: 'RAP002GP', organization_id: rapid.id });
      for (const [ws, bike] of [[rapidWs, rapidBike], [kasiWs, kasiBike], [sharedWs, spare]]) {
        await pgDb.query(
          `INSERT INTO service_bookings (bike_id, starts_at, status, location_id)
           VALUES ($1, NOW() + interval '2 days', 'booked', $2)`, [bike.id, ws]);
      }
    });

    it('shows the whole floor to a technician belonging to nobody', async () => {
      const to = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      const from = new Date().toISOString().slice(0, 10);
      const res = await request(app).get(`/api/bookings/day?from=${from}&to=${to}`).set(authHeader(floorTech.user));
      expect(res.body.bookings).toHaveLength(3);
    });

    it('and only their own bay to a fleet\'s mechanic', async () => {
      const to = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      const from = new Date().toISOString().slice(0, 10);
      const res = await request(app).get(`/api/bookings/day?from=${from}&to=${to}`).set(authHeader(rapidTech.user));
      expect(res.body.bookings).toHaveLength(1);
      expect(res.body.bookings[0].location_id).toBe(rapidWs);
    });

    // Arriving a motorcycle opens a job card on it. Reaching a booking by its
    // number at a workshop that is not yours would open one on a bike that is
    // not yours either.
    it('and a mechanic cannot arrive a bike at another fleet\'s bay', async () => {
      const { rows } = await pgDb.query(
        'SELECT id FROM service_bookings WHERE location_id = $1', [kasiWs]);
      const res = await request(app).post(`/api/bookings/${rows[0].id}/arrive`).set(authHeader(rapidTech.user));
      expect(res.status).toBe(404);
      const { rows: after } = await pgDb.query('SELECT status, job_card_id FROM service_bookings WHERE id = $1', [rows[0].id]);
      expect(after[0]).toMatchObject({ status: 'booked', job_card_id: null });
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('attaching a mechanic to a fleet', () => {
  let superadmin, org;

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    org = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
  });

  const create = (body) =>
    request(app).post('/api/admin/users').set(authHeader(superadmin.user)).send(body);

  it('makes the mechanic theirs', async () => {
    const res = await create({
      email: 'mechanic@rapid.test', password: 'workshop-pass', full_name: 'Thabo M',
      role: 'technician', organization_id: org.id,
    });
    expect(res.status).toBe(200);
    const { rows } = await pgDb.query('SELECT organization_id FROM users WHERE id = $1', [res.body.id]);
    expect(rows[0].organization_id).toBe(org.id);
  });

  // The old shape, and still the default: the platform's own workshop.
  it('and leaving it out still makes a platform technician', async () => {
    const res = await create({
      email: 'floor@platform.test', password: 'workshop-pass', full_name: 'Floor Tech', role: 'technician',
    });
    const { rows } = await pgDb.query('SELECT organization_id FROM users WHERE id = $1', [res.body.id]);
    expect(rows[0].organization_id).toBeNull();
  });

  it('refuses a fleet that does not exist', async () => {
    const res = await create({
      email: 'ghost@nowhere.test', password: 'workshop-pass', full_name: 'Ghost',
      role: 'technician', organization_id: 999999,
    });
    expect(res.status).toBe(404);
  });

  // A rider belongs to a fleet through their motorcycle, and an admin to the
  // platform. Neither is a thing to set here.
  it('and refuses to put an admin in one', async () => {
    const res = await create({
      email: 'boss@rapid.test', password: 'admin-pass', full_name: 'Boss',
      role: 'admin', organization_id: org.id,
    });
    expect(res.status).toBe(400);
  });
});
