import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Two fleets on one platform.
//
// This is the test the whole shape of Phase 3 exists for. The admin portal's
// routers — admin.js, bikes.js, agreements.js, payments.js, tracking.js,
// claims.js — contain not one reference to the caller's organisation between
// them. They were written for an operator who owns every bike in the
// database, and on a telematics deployment that operator is not the person
// looking at the screen.
//
// So the capabilities were rebuilt on fleet.js instead, and what follows is
// the proof that they came out tenant-safe: everything Rapid can see, and
// nothing of Kasi's, checked one endpoint at a time. Each case asserts both
// halves on purpose — an endpoint that returns nothing to anybody would pass
// the "cannot see theirs" half perfectly.

describe.skipIf(!process.env.DATABASE_URL)('two fleets on one platform', () => {
  let rapid, kasi, rapidOwner, kasiOwner, rapidBike, kasiBike, rapidRider, kasiRider;

  beforeEach(async () => {
    await resetAllPgTables();
    // Both on Complete: this file is about the boundary between two tenants,
    // not about what a tier includes. Leaving them untiered would make every
    // case below fail on the tier gate instead, which proves nothing about
    // isolation and hides it if isolation breaks.
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier = 'complete', status = 'active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    rapidOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    rapidRider = await createPgUser({ role: 'rider', organization_id: rapid.id, full_name: 'Rapid Rider' });
    kasiRider = await createPgUser({ role: 'rider', organization_id: kasi.id, full_name: 'Kasi Rider' });

    rapidBike = await createPgBike({ registration: 'RAPID1', organization_id: rapid.id });
    kasiBike = await createPgBike({ registration: 'KASI1', organization_id: kasi.id });
  });

  const asRapid = (path) => request(app).get(path).set(authHeader(rapidOwner.user));

  describe('the workshop', () => {
    beforeEach(async () => {
      for (const [bike, reg] of [[rapidBike, 'RAPID1'], [kasiBike, 'KASI1']]) {
        await pgDb.query(
          `INSERT INTO job_cards (bike_id, registration, status, job_type, description, created_by)
           VALUES ($1,$2,'open','service','Routine service',$3)`,
          [bike.id, reg, rapidOwner.user.id]);
      }
    });

    it('shows a fleet its own job cards', async () => {
      const res = await asRapid('/api/fleet/workshop/job-cards');
      expect(res.status).toBe(200);
      expect(res.body.job_cards.map((j) => j.registration)).toEqual(['RAPID1']);
    });

    it('and not the other fleet\'s', async () => {
      const res = await asRapid('/api/fleet/workshop/job-cards');
      expect(res.body.job_cards.map((j) => j.registration)).not.toContain('KASI1');
    });

    // Asking for it by id directly is the attempt that matters — a list can be
    // filtered and a detail route forgotten.
    it('will not hand over the other fleet\'s job card by id', async () => {
      const { rows } = await pgDb.query(`SELECT id FROM job_cards WHERE registration = 'KASI1'`);
      const res = await asRapid(`/api/fleet/workshop/job-cards/${rows[0].id}`);
      expect(res.status).toBe(404);
    });

    it('but does hand over its own', async () => {
      const { rows } = await pgDb.query(`SELECT id FROM job_cards WHERE registration = 'RAPID1'`);
      const res = await asRapid(`/api/fleet/workshop/job-cards/${rows[0].id}`);
      expect(res.status).toBe(200);
      expect(res.body.job_card.registration).toBe('RAPID1');
    });

    it('lists only its own bikes as due for service', async () => {
      await pgDb.query(`UPDATE bikes SET next_service_date = CURRENT_DATE - 1, odometer_km = 9000, next_service_km = 8000`);
      const res = await asRapid('/api/fleet/workshop/service-due');
      expect(res.status).toBe(200);
      expect(res.body.bikes.every((b) => b.registration === 'RAPID1')).toBe(true);
    });
  });

  describe('rider applications', () => {
    beforeEach(async () => {
      for (const rider of [rapidRider, kasiRider]) {
        await pgDb.query(
          `INSERT INTO applications (user_id, status) VALUES ($1,'submitted')`, [rider.user.id]);
      }
    });

    it('shows a fleet applications from its own riders', async () => {
      const res = await asRapid('/api/fleet/applications');
      expect(res.status).toBe(200);
      expect(res.body.applications.map((a) => a.full_name)).toEqual(['Rapid Rider']);
    });

    it('will not hand over another fleet\'s application by id', async () => {
      const { rows } = await pgDb.query('SELECT id FROM applications WHERE user_id = $1', [kasiRider.user.id]);
      const res = await asRapid(`/api/fleet/applications/${rows[0].id}`);
      expect(res.status).toBe(404);
    });

    it('but does hand over its own', async () => {
      const { rows } = await pgDb.query('SELECT id FROM applications WHERE user_id = $1', [rapidRider.user.id]);
      const res = await asRapid(`/api/fleet/applications/${rows[0].id}`);
      expect(res.status).toBe(200);
    });
  });

  describe('theft cases and claims', () => {
    beforeEach(async () => {
      for (const bike of [rapidBike, kasiBike]) {
        await pgDb.query(`INSERT INTO theft_cases (bike_id, status) VALUES ($1,'open')`, [bike.id]);
        await pgDb.query(
          `INSERT INTO insurance_claims (bike_id, status, claim_type, description, filed_by)
           VALUES ($1,'filed','accident','Rear-ended at a robot',$2)`, [bike.id, rapidOwner.user.id]);
      }
    });

    it('shows a fleet only its own theft cases', async () => {
      const res = await asRapid('/api/fleet/theft-cases');
      expect(res.status).toBe(200);
      expect(res.body.theft_cases.map((c) => c.registration)).toEqual(['RAPID1']);
    });

    it('and only its own claims', async () => {
      const res = await asRapid('/api/fleet/claims');
      expect(res.status).toBe(200);
      expect(res.body.claims.map((c) => c.registration)).toEqual(['RAPID1']);
    });
  });

  describe('the fleet\'s own activity', () => {
    beforeEach(async () => {
      await pgDb.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'bike.updated','bikes',$2)`,
        [rapidOwner.user.id, rapidBike.id]);
      await pgDb.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id) VALUES ($1,'bike.updated','bikes',$2)`,
        [kasiOwner.user.id, kasiBike.id]);
      for (const rider of [rapidRider, kasiRider]) {
        await pgDb.query(
          `INSERT INTO notifications (user_id, channel, type, title, message, status)
           VALUES ($1,'sms','service_reminder','Service due','Your bike is due','sent')`, [rider.user.id]);
      }
    });

    it('shows what its own people did', async () => {
      const res = await asRapid('/api/fleet/activity/audit');
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e) => e.actor_name)).toEqual([rapidOwner.user.full_name]);
    });

    it('and messages sent to its own riders only', async () => {
      const res = await asRapid('/api/fleet/activity/notifications');
      expect(res.status).toBe(200);
      expect(res.body.notifications.map((n) => n.recipient_name)).toEqual(['Rapid Rider']);
    });
  });

  // The roles inside a fleet, which are a separate question from the fleet
  // boundary but fail just as quietly.
  describe('roles within a fleet', () => {
    it('keeps a viewer out of the workshop', async () => {
      const viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });
      const res = await request(app).get('/api/fleet/workshop/job-cards').set(authHeader(viewer.user));
      expect(res.status).toBe(403);
    });

    it('keeps everyone but the company admin out of the audit trail', async () => {
      const ops = await createPgUser({ role: 'fleet_owner_ops', organization_id: rapid.id });
      const res = await request(app).get('/api/fleet/activity/audit').set(authHeader(ops.user));
      expect(res.status).toBe(403);
    });

    it('and a rider out of all of it', async () => {
      for (const path of ['/api/fleet/workshop/job-cards', '/api/fleet/applications',
        '/api/fleet/theft-cases', '/api/fleet/claims', '/api/fleet/activity/audit']) {
        const res = await request(app).get(path).set(authHeader(rapidRider.user));
        expect(res.status, `${path} let a rider in`).toBe(403);
      }
    });
  });
});
