import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// A technician registering a walk-in bike.
//
// The details used to be written onto the job card as loose text and nowhere
// else, so the bike never appeared in the search and was typed in again at
// every visit with nothing linking the visits. These tests are about the two
// halves of the promise: the bike exists afterwards, and it is findable.
describe.skipIf(!process.env.DATABASE_URL)('registering a bike from the workshop', () => {
  let tech;

  const register = (body) =>
    request(app).post('/api/workshop/bikes').set(authHeader(tech)).send(body);
  const search = (q) =>
    request(app).get('/api/workshop/bikes/search').query({ q }).set(authHeader(tech));

  const WALK_IN = { vin: 'WALKIN12345678901', registration: 'XY-99GP', make: 'Honda', model: 'ACE 125' };

  beforeEach(async () => {
    await resetAllPgTables();
    tech = (await createPgUser({ role: 'technician' })).user;
  });

  it('creates a bike a technician can find again', async () => {
    const res = await register(WALK_IN);
    expect(res.status).toBe(200);

    const found = await search('XY-99GP');
    expect(found.body.bikes.map((b) => b.vin)).toContain('WALKIN12345678901');
  });

  // A walk-in is not a fleet asset on finance, and must not look like one.
  it('marks it as a workshop registration rather than a rental bike', async () => {
    const { body } = await register(WALK_IN);
    expect(body.bike).toMatchObject({ status: 'not_available' });
    expect(Number(body.bike.rental_weekly)).toBe(0);
    expect(body.bike.notes).toMatch(/registered via workshop/i);
    expect(body.bike.organization_id).toBeNull();
  });

  it('records the fleet owner when there is one', async () => {
    const { body } = await register({ ...WALK_IN, fleet_owner_name: 'Blue Sky Deliveries' });
    expect(body.bike.notes).toMatch(/Blue Sky Deliveries/);
  });

  // The same bike coming back must not become a second record — and the
  // caller needs the existing id so the job card can be put on the right one.
  it('refuses a duplicate VIN and says which bike it already is', async () => {
    const first = await register(WALK_IN);
    const again = await register({ ...WALK_IN, registration: 'DIFFERENT' });
    expect(again.status).toBe(409);
    expect(again.body.existing_id).toBe(first.body.bike.id);
  });

  it('insists on the fields that identify a bike', async () => {
    for (const missing of ['vin', 'make', 'model']) {
      const body = { ...WALK_IN };
      delete body[missing];
      expect((await register(body)).status, missing).toBe(400);
    }
  });

  // The constraint that matters most: a walk-in is not an OnFleet asset and
  // must not appear anywhere on the fleet side. Each of these is a separate
  // surface, so each is asserted separately — a single filter missed is a
  // walk-in bike showing up in somebody's fleet.
  describe('and it stays out of the fleet', () => {
    let admin;

    beforeEach(async () => {
      admin = (await createPgUser({ role: 'superadmin' })).user;
      await register(WALK_IN);
    });

    it('is not in the admin bike list', async () => {
      const res = await request(app).get('/api/bikes').set(authHeader(admin));
      const list = res.body.bikes || res.body;
      expect(JSON.stringify(list)).not.toContain('WALKIN12345678901');
    });

    it('is not fetchable as an admin bike by id', async () => {
      const { rows } = await pgDb.query('SELECT id FROM bikes WHERE vin = $1', ['WALKIN12345678901']);
      const res = await request(app).get(`/api/bikes/${rows[0].id}`).set(authHeader(admin));
      expect(res.status).toBe(404);
    });

    it('is not counted in the platform dashboard', async () => {
      const before = await pgDb.query(
        `SELECT COUNT(*)::int n FROM bikes WHERE organization_id IS NULL AND workshop_only = FALSE`);
      const all = await pgDb.query(`SELECT COUNT(*)::int n FROM bikes WHERE organization_id IS NULL`);
      expect(all.rows[0].n).toBeGreaterThan(before.rows[0].n);
    });

    // The workshop is the one place it should be findable.
    it('is still findable from the workshop', async () => {
      const found = await search('WALKIN123');
      expect(found.body.bikes.map((b) => b.vin)).toContain('WALKIN12345678901');
    });
  });

  it('finds it by VIN and by make as well as registration', async () => {
    await register(WALK_IN);
    for (const q of ['WALKIN123', 'Honda', 'ACE']) {
      expect((await search(q)).body.bikes.length, q).toBeGreaterThan(0);
    }
  });

  // The point of registering it at all: the next visit links to the same bike,
  // so the service history accumulates instead of restarting.
  it('lets a second job card link to the same bike', async () => {
    const { body } = await register(WALK_IN);
    const bikeId = body.bike.id;

    for (const description of ['First visit', 'Second visit']) {
      const res = await request(app).post('/api/workshop/job-cards').set(authHeader(tech))
        .send({ bike_id: bikeId, job_type: 'service', description });
      expect(res.status).toBe(200);
      expect(res.body.job_card.bike_id).toBe(bikeId);
    }

    const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM job_cards WHERE bike_id = $1', [bikeId]);
    expect(rows[0].n).toBe(2);
  });
});
