import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';

// Where a telematics operator's admin account stops.
//
// Pillion sells the platform; it owns no motorcycles. Its console already
// left a tenant's applications, agreements, rider payments, claims and
// workshop off the menu — but a menu is not a boundary. The pages were one
// typed URL away and the API answered, so a platform admin could work inside
// somebody else's operating records without ever seeing whose they were.
//
// The brand is read when the module loads, so the app has to be imported
// after the environment says which deployment this is.
//
// BRAND is process-wide and the suite runs files sequentially in one worker,
// so leaving it set would quietly turn every file that loads afterwards into
// a Pillion deployment. Vitest isolates the module registry, not the
// environment; this has to be put back by hand.
const BRAND_BEFORE = process.env.BRAND;
process.env.BRAND = 'pillion';
afterAll(() => {
  if (BRAND_BEFORE === undefined) delete process.env.BRAND;
  else process.env.BRAND = BRAND_BEFORE;
});

const { default: buildApp } = await import('../src/app.js');
const {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader,
} = await import('./helpers/testPgDb.js');

const app = buildApp();

describe.skipIf(!process.env.DATABASE_URL)('a platform admin on a telematics deployment', () => {
  let admin, superadmin, tech, rider, org, bike, agreement;

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id=$1`, [org.id]);
    admin = await createPgUser({ role: 'admin' });
    superadmin = await createPgUser({ role: 'superadmin' });
    tech = await createPgUser({ role: 'technician' });
    rider = await createPgUser({ role: 'rider', organization_id: org.id });
    bike = await createPgBike({ registration: 'RAP001GP', organization_id: org.id });
    agreement = await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
  });

  const asAdmin = (method, path) => request(app)[method](path).set(authHeader(admin.user));

  describe('cannot reach a tenant\'s operating records', () => {
    const shut = [
      ['get', '/api/agreements'],
      ['get', '/api/agreements/1'],
      ['get', '/api/applications'],
      ['get', '/api/payments/all'],
      ['get', '/api/claims'],
      ['get', '/api/workshop/job-cards'],
      ['get', '/api/kyc/all'],
      ['post', '/api/imports/payments'],
    ];

    it.each(shut)('%s %s', async (method, path) => {
      const res = await asAdmin(method, path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    it('and a superadmin is no different', async () => {
      const res = await request(app).get('/api/agreements').set(authHeader(superadmin.user));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    // The workshop endpoints let admins in by design, which would have been a
    // way straight around the boundary.
    it('nor through the workshop door', async () => {
      const res = await asAdmin('get', '/api/workshop/job-cards');
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    // Nor through a route that takes any authenticated caller and branches on
    // the role inside. This one hands an admin the whole bundle — schedule,
    // payments, the rider's documents — and never passes an admin guard,
    // which is why the boundary cannot live on one.
    it('nor a route that checks the role itself', async () => {
      const res = await asAdmin('get', `/api/agreements/${agreement.id}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    it('and it refuses the write, not just the read', async () => {
      const res = await request(app).post('/api/claims').set(authHeader(admin.user))
        .send({ bike_id: bike.id, claim_type: 'theft', description: 'Not mine to file' });
      expect(res.status).toBe(403);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM insurance_claims');
      expect(rows[0].n, 'a platform admin filed a claim on a tenant\'s bike').toBe(0);
    });
  });

  // /api/admin was left whole when this boundary went in, on the grounds that
  // it is the console's own API. Most of it is. These are the parts that are
  // a customer's business rather than the operator's.
  describe('nor the parts of the admin API that belong to a fleet', () => {
    const shut = [
      ['get', '/api/admin/org-agreements?org_id=1'],
      ['get', '/api/admin/agreement-schedule?agreement_id=1'],
      ['get', '/api/admin/riders/scorecards'],
      ['get', '/api/admin/signup-stats'],
      ['get', '/api/admin/strategy-report'],
      ['get', '/api/admin/dashboard'],
      ['get', '/api/admin/kpis'],
      ['get', '/api/admin/parts-catalog'],
      ['get', '/api/admin/parts-orders'],
    ];

    it.each(shut)('%s %s', async (method, path) => {
      const res = await request(app)[method](path).set(authHeader(superadmin.user));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    // Recording a payment here means a rider's payment against a rider's
    // schedule, which only makes sense where the operator is the lessor.
    it('and cannot record a rider\'s payment', async () => {
      const res = await request(app).post('/api/admin/record-paystack-payment')
        .set(authHeader(superadmin.user)).send({ organization_id: org.id, amount: 500 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });
  });

  describe('but the console it does have still works', () => {
    it('the fleets it sells to', async () => {
      const res = await request(app).get('/api/admin/fleet-owners').set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
    });

    // A device is fitted to a motorcycle, so commissioning one has to read
    // bikes. The Bikes page is off the menu; the records behind tracking stay.
    it('the devices, and the bikes they are fitted to', async () => {
      expect((await asAdmin('get', '/api/tracking/devices')).status).toBe(200);
      expect((await asAdmin('get', '/api/bikes')).status).toBe(200);
    });

    it('and the audit trail', async () => {
      expect((await asAdmin('get', '/api/admin/audit-logs')).status).toBe(200);
    });

    // The line is between administering an account and reading what the
    // account does with the platform. Everything here is the first kind, and
    // breaking any of it would take the console with it.
    it('and the account administration the console is made of', async () => {
      for (const path of [
        '/api/admin/users',
        '/api/admin/fleet-owners/dashboard',
        '/api/admin/fleet-payouts',
        '/api/admin/paystack-charges',
        '/api/admin/integrations/api-keys',
        '/api/admin/login-attempts',
        '/api/admin/email-provider-status',
      ]) {
        const res = await request(app).get(path).set(authHeader(superadmin.user));
        expect(res.status, `${path} was refused`).toBe(200);
      }
    });

    it('including a fleet\'s wallet and plan, which is what it bills on', async () => {
      const res = await request(app).get(`/api/admin/organizations/${org.id}/wallet`)
        .set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
    });
  });

  // The boundary is about a platform admin reaching sideways. Everybody who
  // owns the data is untouched, which is the part that would be catastrophic
  // to get wrong.
  describe('and nobody else is affected', () => {
    it('a rider still sees their own agreement', async () => {
      const res = await request(app).get('/api/agreements/mine').set(authHeader(rider.user));
      expect(res.status).toBe(200);
      expect(res.body.agreements?.[0]?.id || res.body[0]?.id).toBe(agreement.id);
    });

    it('a fleet owner still has their whole portal', async () => {
      const owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });
      expect((await request(app).get('/api/fleet/agreements').set(authHeader(owner.user))).status).toBe(200);
      expect((await request(app).get('/api/fleet/collections').set(authHeader(owner.user))).status).toBe(200);
    });

    // A fleet's own mechanic. On a telematics deployment every workshop
    // belongs to a customer, so this is who the workshop is for.
    it('a fleet\'s own mechanic works their fleet\'s workshop', async () => {
      const theirs = await createPgUser({ role: 'technician', organization_id: org.id });
      const res = await request(app).get('/api/workshop/job-cards').set(authHeader(theirs.user));
      expect(res.status).toBe(200);
    });

    // And one belonging to nobody is the platform's own, on a platform that
    // runs no workshop. There is nothing for them to be looking at, and what
    // they would have seen is every customer's work.
    it('but a technician belonging to nobody has no workshop to be in', async () => {
      const res = await request(app).get('/api/workshop/job-cards').set(authHeader(tech.user));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_THIS_CONSOLE');
    });

    it('and cannot read the diary either', async () => {
      const res = await request(app).get('/api/bookings/day').set(authHeader(tech.user));
      expect(res.status).toBe(403);
    });
  });
});
