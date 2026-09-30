import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// A fleet hiring its own mechanic.
//
// The workshop was theirs to create and theirs to run, and every mechanic
// still had to be added by the platform operator — a support ticket per hire,
// on a product sold to companies that do their own hiring.
//
// What makes it safe to hand over is the scoping underneath: a technician
// created here belongs to this fleet, and belonging to a fleet is the only
// thing that decides what they can see.

describe.skipIf(!process.env.DATABASE_URL)('a fleet adding its own mechanic', () => {
  let rapid, kasi, owner, ops, viewer, kasiOwner;

  const hire = (user, body) =>
    request(app).post('/api/fleet/team-members').set(authHeader(user)).send(body);

  const A_MECHANIC = {
    full_name: 'Thabo Mokoena', email: 'thabo@rapid.test', password: 'workshop-pass', role: 'technician',
  };

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active', max_admin_users=5 WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    ops = await createPgUser({ role: 'fleet_owner_ops', organization_id: rapid.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
  });

  it('creates them inside that fleet', async () => {
    const res = await hire(owner.user, A_MECHANIC);
    expect(res.status).toBe(201);
    const { rows } = await pgDb.query(
      `SELECT role, organization_id FROM users WHERE email = 'thabo@rapid.test'`);
    expect(rows[0]).toMatchObject({ role: 'technician', organization_id: rapid.id });
  });

  // The organisation comes from who is asking and never from the body, the
  // same as adding a workshop does.
  it('and never inside another fleet, whatever is sent', async () => {
    const res = await hire(owner.user, { ...A_MECHANIC, organization_id: kasi.id });
    expect(res.status).toBe(201);
    const { rows } = await pgDb.query(
      `SELECT organization_id FROM users WHERE email = 'thabo@rapid.test'`);
    expect(rows[0].organization_id, 'a fleet put a mechanic in another fleet').toBe(rapid.id);
  });

  // The scoping this exists for: the new mechanic can see their fleet's work
  // and nobody else's.
  it('and the mechanic sees only that fleet\'s work', async () => {
    await pgDb.query(
      `INSERT INTO workshop_locations (name, city, organization_id) VALUES ('Rapid Bay','Johannesburg',$1), ('Kasi Bay','Soweto',$2)`,
      [rapid.id, kasi.id]);
    await hire(owner.user, A_MECHANIC);

    const { rows } = await pgDb.query(`SELECT id FROM users WHERE email = 'thabo@rapid.test'`);
    const mechanic = { id: rows[0].id, role: 'technician', organization_id: rapid.id };
    const res = await request(app).get('/api/bookings/locations').set(authHeader(mechanic));
    expect(res.body.locations.map((l) => l.name)).toEqual(['Rapid Bay']);
  });

  it('a mechanic takes no admin seat', async () => {
    await pgDb.query('UPDATE organizations SET max_admin_users = 1 WHERE id = $1', [rapid.id]);
    // The one seat is already taken by the owner.
    const res = await hire(owner.user, A_MECHANIC);
    expect(res.status, 'the workshop feature was priced twice').toBe(201);
  });

  it('but a plan without a workshop cannot have one', async () => {
    await pgDb.query(`UPDATE organizations SET subscription_tier='basic' WHERE id=$1`, [rapid.id]);
    const res = await hire(owner.user, A_MECHANIC);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TIER_REQUIRED');
    const { rows } = await pgDb.query(`SELECT COUNT(*)::int n FROM users WHERE email = 'thabo@rapid.test'`);
    expect(rows[0].n).toBe(0);
  });

  it('and a viewer cannot hire anybody', async () => {
    expect((await hire(viewer.user, A_MECHANIC)).status).toBe(403);
  });

  // Team management is the company admin's, and hiring is team management.
  // An operations lead runs the fleet, not the payroll.
  it('nor can an operations lead', async () => {
    expect((await hire(ops.user, A_MECHANIC)).status).toBe(403);
  });

  // The roles a fleet may mint are its own staff. Not an admin, and not a
  // platform technician belonging to nobody.
  it('nor invent a role that is not theirs to give', async () => {
    const res = await hire(owner.user, { ...A_MECHANIC, role: 'superadmin' });
    expect(res.status).toBe(400);
    const { rows } = await pgDb.query(`SELECT COUNT(*)::int n FROM users WHERE email = 'thabo@rapid.test'`);
    expect(rows[0].n, 'a fleet owner made themselves a superadmin').toBe(0);
  });

  describe('afterwards', () => {
    let mechanicId;

    beforeEach(async () => {
      await hire(owner.user, A_MECHANIC);
      const { rows } = await pgDb.query(`SELECT id FROM users WHERE email = 'thabo@rapid.test'`);
      mechanicId = rows[0].id;
    });

    it('they show up on the team', async () => {
      const res = await request(app).get('/api/fleet/account').set(authHeader(owner.user));
      expect(res.body.members.map((m) => m.email)).toContain('thabo@rapid.test');
    });

    // Suspending one used to be refused outright: the role coming back
    // unchanged was not one the team list knew about.
    it('and can be suspended', async () => {
      const res = await request(app).patch(`/api/fleet/team-members/${mechanicId}`)
        .set(authHeader(owner.user)).send({ status: 'suspended' });
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query('SELECT status FROM users WHERE id = $1', [mechanicId]);
      expect(rows[0].status).toBe('suspended');
    });

    it('and removed', async () => {
      const res = await request(app).delete(`/api/fleet/team-members/${mechanicId}`).set(authHeader(owner.user));
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query('SELECT deleted_at FROM users WHERE id = $1', [mechanicId]);
      expect(rows[0].deleted_at).toBeTruthy();
    });

    // A workshop login is not a way into the fleet portal.
    it('but not promoted into the portal', async () => {
      const res = await request(app).patch(`/api/fleet/team-members/${mechanicId}`)
        .set(authHeader(owner.user)).send({ role: 'fleet_owner_admin' });
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT role FROM users WHERE id = $1', [mechanicId]);
      expect(rows[0].role).toBe('technician');
    });

    it('and another fleet cannot touch them', async () => {
      const res = await request(app).patch(`/api/fleet/team-members/${mechanicId}`)
        .set(authHeader(kasiOwner.user)).send({ status: 'suspended' });
      expect(res.status).toBe(404);
    });
  });
});

// The surface a mechanic inherits. Opening the door to fleet-created
// technicians means everything a technician can reach is now reachable by a
// tenant's staff, so the things that were global have to stop being global.
describe.skipIf(!process.env.DATABASE_URL)('what a fleet\'s mechanic can reach', () => {
  let rapid, kasi, rapidTech, floorTech;

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    rapidTech = await createPgUser({ role: 'technician', organization_id: rapid.id });
    floorTech = await createPgUser({ role: 'technician' });
    await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id, status: 'active' });
    await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id, status: 'active' });
  });

  const asTech = (user, path) => request(app).get(path).set(authHeader(user));

  it('finds their own fleet\'s motorcycles, and not another\'s', async () => {
    const mine = await asTech(rapidTech.user, '/api/workshop/bikes/search?q=GP');
    expect(mine.body.bikes.map((b) => b.registration)).toEqual(['RAP001GP']);

    const floor = await asTech(floorTech.user, '/api/workshop/bikes/search?q=GP');
    expect(floor.body.bikes.map((b) => b.registration).sort()).toEqual(['KAS001GP', 'RAP001GP']);
  });

  // The query parameter is a filter for somebody who may see everything, not
  // a way to pick a fleet.
  //
  // The first version of this test passed either way, because neither bike
  // was due for anything and an empty list satisfies any assertion about what
  // is not in it. Both are overdue here, so the list has something to leak.
  it('and cannot ask for another fleet\'s service list by naming it', async () => {
    await pgDb.query(
      `UPDATE bikes SET next_service_date = CURRENT_DATE - 30, odometer_km = 20000, next_service_km = 15000`);

    const floor = await asTech(floorTech.user, '/api/workshop/service-due');
    expect(floor.body.bikes.map((b) => b.registration).sort(),
      'the fixture has nothing due, so this proves nothing').toEqual(['KAS001GP', 'RAP001GP']);

    const res = await asTech(rapidTech.user, `/api/workshop/service-due?organization_id=${kasi.id}`);
    expect(res.status).toBe(200);
    expect(res.body.bikes.map((b) => b.registration)).toEqual(['RAP001GP']);
  });

  it('sees their own colleagues, not the platform\'s staff directory', async () => {
    await createPgUser({ role: 'technician', organization_id: rapid.id, full_name: 'Colleague' });
    const res = await asTech(rapidTech.user, '/api/workshop/technicians');
    const ids = res.body.technicians.map((t) => t.id);
    expect(ids).toContain(rapidTech.user.id);
    expect(ids, 'a fleet\'s mechanic saw the platform\'s staff').not.toContain(floorTech.user.id);
  });

  // Job templates are shared by everybody using the workshop software.
  it('may use the shared job templates but not rewrite them', async () => {
    const res = await request(app).post('/api/workshop/templates').set(authHeader(rapidTech.user))
      .send({ name: 'Mine now', job_type: 'service', items: [] });
    expect(res.status).toBe(403);
  });

  it('while the platform\'s own technician still can', async () => {
    const res = await request(app).post('/api/workshop/templates').set(authHeader(floorTech.user))
      .send({ name: 'Standard service', job_type: 'service', items: [] });
    expect(res.status).toBe(200);
  });
});
