import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, authHeader, TEST_PASSWORD } from './helpers/testPgDb.js';

const onboarding = createRequire(import.meta.url)('../src/services/fleetOnboarding.js');
const app = buildApp();

// Putting a fleet on the platform from the operator's side.
//
// A telematics business signs its customers up on a sales call, on a plan that
// was negotiated, by somebody who is not the customer. Until this existed the
// only way an organisation could come into being was public self-serve signup,
// which gets all three of those wrong.

const FLEET = {
  company_name: 'Rapid Wheels',
  full_name: 'Thabo Nkosi',
  email: 'thabo@rapidwheels.test',
  phone: '0810000000',
  city: 'Johannesburg',
  fleet_size: 24,
};

describe.skipIf(!process.env.DATABASE_URL)('onboarding a fleet', () => {
  let admin, tech, rider;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    rider = await createPgUser({ role: 'rider' });
  });

  const onboard = (user, body) =>
    request(app).post('/api/admin/fleet-owners').set(authHeader(user)).send(body);

  describe('what the operator gets', () => {
    it('creates the fleet and its first user in one go', async () => {
      const res = await onboard(admin.user, { ...FLEET, plan_key: 'medium' });
      expect(res.status).toBe(201);
      expect(res.body.organization.name).toBe('Rapid Wheels');
      expect(res.body.owner.email).toBe('thabo@rapidwheels.test');
      expect(res.body.owner.role).toBe('fleet_owner_admin');
    });

    it('applies the plan\'s entitlements rather than the defaults', async () => {
      await onboard(admin.user, { ...FLEET, plan_key: 'medium' });
      const { rows } = await pgDb.query('SELECT plan_key, max_bikes, max_admin_users FROM organizations WHERE slug = $1', ['rapid-wheels']);
      expect(rows[0].plan_key).toBe('medium');
      expect(rows[0].max_bikes).toBe(60);
      expect(rows[0].max_admin_users).toBe(5);
    });

    // Self-serve signup can only ever create a trial. An operator closing a
    // deal needs to put the fleet straight onto a paid plan.
    it('can put a fleet straight onto a paid plan, with no trial clock', async () => {
      const res = await onboard(admin.user, { ...FLEET, plan_key: 'large', status: 'active' });
      expect(res.status).toBe(201);
      const { rows } = await pgDb.query('SELECT status, trial_ends_at FROM organizations WHERE slug = $1', ['rapid-wheels']);
      expect(rows[0].status).toBe('active');
      expect(rows[0].trial_ends_at).toBeNull();
    });

    it('still starts a trial clock when it is a trial', async () => {
      await onboard(admin.user, { ...FLEET, status: 'trialing' });
      const { rows } = await pgDb.query('SELECT status, trial_ends_at FROM organizations WHERE slug = $1', ['rapid-wheels']);
      expect(rows[0].status).toBe('trialing');
      expect(rows[0].trial_ends_at).toBeTruthy();
    });

    it('gives two fleets of the same name different slugs', async () => {
      await onboard(admin.user, FLEET);
      await onboard(admin.user, { ...FLEET, email: 'second@rapidwheels.test' });
      const { rows } = await pgDb.query(
        `SELECT slug FROM organizations WHERE name = 'Rapid Wheels' ORDER BY id`);
      expect(rows.map((r) => r.slug)).toEqual(['rapid-wheels', 'rapid-wheels-2']);
    });
  });

  // The whole point of not taking a password here.
  describe('the account the customer receives', () => {
    it('cannot be signed into until they set a password', async () => {
      const res = await onboard(admin.user, FLEET);
      expect(res.body.needs_password_setup).toBe(true);

      // Not the test password, not blank, not the email — nothing works.
      for (const guess of [TEST_PASSWORD, '', 'password', FLEET.email]) {
        const attempt = await request(app).post('/api/auth/login')
          .send({ email: FLEET.email, password: guess });
        expect(attempt.status, `"${guess}" should not sign them in`).not.toBe(200);
      }
    });

    it('exists and owns the fleet regardless', async () => {
      await onboard(admin.user, FLEET);
      const { rows } = await pgDb.query(
        `SELECT u.role, u.status, o.name FROM users u JOIN organizations o ON o.id = u.organization_id
          WHERE u.email = $1`, [FLEET.email]);
      expect(rows[0].role).toBe('fleet_owner_admin');
      expect(rows[0].status).toBe('active');
      expect(rows[0].name).toBe('Rapid Wheels');
    });

    // The fleet is fine even when the mail gateway is not, and the operator is
    // told rather than being shown a success they cannot rely on.
    it('is reported as created even if the invite cannot be sent', async () => {
      const res = await onboard(admin.user, { ...FLEET, send_invite: false });
      expect(res.status).toBe(201);
      expect(res.body.invited).toBe(false);
      const { rows } = await pgDb.query('SELECT id FROM organizations WHERE slug = $1', ['rapid-wheels']);
      expect(rows).toHaveLength(1);
    });
  });

  describe('what it refuses', () => {
    it('an email that already has an account', async () => {
      await onboard(admin.user, FLEET);
      const again = await onboard(admin.user, { ...FLEET, company_name: 'Another Fleet' });
      expect(again.status).toBe(409);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM organizations');
      expect(rows[0].n).toBe(1); // the second fleet was not left behind
    });

    it('a fleet with no company name', async () => {
      const res = await onboard(admin.user, { ...FLEET, company_name: '' });
      expect(res.status).toBe(400);
    });

    it('a fleet with no contact name', async () => {
      const res = await onboard(admin.user, { ...FLEET, full_name: '  ' });
      expect(res.status).toBe(400);
    });

    it('an address that is not an email', async () => {
      const res = await onboard(admin.user, { ...FLEET, email: 'not-an-address' });
      expect(res.status).toBe(400);
    });

    it('a status a new fleet cannot start in', async () => {
      const res = await onboard(admin.user, { ...FLEET, status: 'suspended' });
      expect(res.status).toBe(400);
    });

    it('a role that is not a fleet-owner role — nobody onboards an admin', async () => {
      const res = await onboard(admin.user, { ...FLEET, role: 'superadmin' });
      expect(res.status).toBe(400);
    });

    it('an unknown plan falls back to trial rather than inventing entitlements', async () => {
      await onboard(admin.user, { ...FLEET, plan_key: 'platinum-deluxe' });
      const { rows } = await pgDb.query('SELECT plan_key, max_bikes FROM organizations WHERE slug = $1', ['rapid-wheels']);
      expect(rows[0].plan_key).toBe('trial');
      expect(rows[0].max_bikes).toBe(onboarding.FLEET_PLAN_ENTITLEMENTS.trial.max_bikes);
    });
  });

  describe('who may do it', () => {
    it('not a technician', async () => {
      expect((await onboard(tech.user, FLEET)).status).toBe(403);
    });

    it('not a rider', async () => {
      expect((await onboard(rider.user, FLEET)).status).toBe(403);
    });

    it('and it is written to the audit log', async () => {
      await onboard(admin.user, FLEET);
      const { rows } = await pgDb.query(
        `SELECT action, entity FROM audit_logs WHERE action = 'fleet_owner.onboarded'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].entity).toBe('organizations');
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('the self-serve signup it now shares code with', () => {
  beforeEach(async () => { await resetAllPgTables(); });

  // Regression: public signup was rewritten to call the same service. It has
  // a password, and must still come back signed in.
  it('still creates a fleet and signs the owner straight in', async () => {
    const res = await request(app).post('/api/auth/fleet/signup').send({
      company_name: 'Kasi Couriers',
      full_name: 'Lerato M',
      email: 'lerato@kasi.test',
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.organization_name).toBe('Kasi Couriers');
  });

  it('and that owner can log in with the password they chose', async () => {
    await request(app).post('/api/auth/fleet/signup').send({
      company_name: 'Kasi Couriers', full_name: 'Lerato M',
      email: 'lerato@kasi.test', password: 'Password123!',
    });
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'lerato@kasi.test', password: 'Password123!' });
    expect(login.status).toBe(200);
  });

  it('still refuses an email that is already taken', async () => {
    const body = { company_name: 'A', full_name: 'B', email: 'dup@kasi.test', password: 'Password123!' };
    await request(app).post('/api/auth/fleet/signup').send(body);
    const again = await request(app).post('/api/auth/fleet/signup').send(body);
    expect(again.status).toBe(409);
  });
});

// The bug this exists to stop happening again.
//
// There were three copies of the plan table and two of them offered a plan
// called `empire`. The organizations table has never accepted that value, so
// onboarding a fleet on Empire failed with a check-constraint violation and a
// 500 — a plan on the form that could not be chosen. Nothing checked that the
// plans the code offers are plans the database will take.
describe.skipIf(!process.env.DATABASE_URL)('every plan on offer', () => {
  let admin;
  beforeEach(async () => {
    await resetAllPgTables();
    admin = await createPgUser({ role: 'superadmin' });
  });

  for (const plan of Object.keys(onboarding.FLEET_PLAN_ENTITLEMENTS)) {
    it(`can actually create a fleet: ${plan}`, async () => {
      const res = await request(app).post('/api/admin/fleet-owners')
        .set(authHeader(admin.user))
        .send({ ...FLEET, email: `${plan}@plans.test`, plan_key: plan });
      expect(res.status, res.body?.error).toBe(201);
      expect(res.body.organization.plan_key).toBe(plan);
    });
  }

  it('and the entitlements land on the row', async () => {
    await request(app).post('/api/admin/fleet-owners').set(authHeader(admin.user))
      .send({ ...FLEET, plan_key: 'medium' });
    const { rows } = await pgDb.query('SELECT max_bikes, max_admin_users FROM organizations WHERE slug = $1', ['rapid-wheels']);
    const want = onboarding.FLEET_PLAN_ENTITLEMENTS.medium;
    expect(rows[0].max_bikes).toBe(want.max_bikes);
    expect(rows[0].max_admin_users).toBe(want.max_admin_users);
  });
});

describe('the plan entitlements, now in one place', () => {
  it('is the table every signup path reads', () => {
    expect(onboarding.entitlementsFor('medium')).toEqual(onboarding.FLEET_PLAN_ENTITLEMENTS.medium);
    expect(onboarding.entitlementsFor('enterprise').max_bikes).toBe(999);
  });

  it('falls back to trial for anything it does not recognise', () => {
    expect(onboarding.entitlementsFor('nonsense')).toEqual(onboarding.FLEET_PLAN_ENTITLEMENTS.trial);
    expect(onboarding.entitlementsFor()).toEqual(onboarding.FLEET_PLAN_ENTITLEMENTS.trial);
  });

  // The plan called `empire` is the one that could never be saved.
  it('no longer offers a plan the database has never accepted', () => {
    expect(Object.keys(onboarding.FLEET_PLAN_ENTITLEMENTS)).not.toContain('empire');
    expect(Object.keys(onboarding.FLEET_PLAN_ENTITLEMENTS)).toContain('enterprise');
  });
});
