import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// A fleet owner deciding a rider's application.
//
// This is the largest write a fleet owner can make. Approving does not set a
// flag: it allocates a bike, opens an agreement, builds the payment schedule
// for the whole term and writes the contract the rider signs. Getting it
// wrong across tenants would put one fleet's motorcycle under another fleet's
// rider, on a contract neither of them agreed.
//
// The flow shipped without a test. These are for the decision itself and for
// the edges that make it refuse.

const todayIso = () => new Date().toISOString().slice(0, 10);

describe.skipIf(!process.env.DATABASE_URL)('a fleet owner deciding an application', () => {
  let rapid, kasi, rapidOwner, kasiOwner, viewer;
  let rapidRider, kasiRider, rapidBike, kasiBike, rapidApp, kasiApp;

  const applyFor = async (userId, bikeId = null) => {
    const { rows } = await pgDb.query(
      `INSERT INTO applications (user_id, preferred_bike_id, status, monthly_income)
       VALUES ($1,$2,'submitted',12000) RETURNING *`, [userId, bikeId]);
    return rows[0];
  };

  const approve = (user, applicationId, body = {}) =>
    request(app).post(`/api/fleet/riders/${applicationId}/approve`).set(authHeader(user)).send(body);

  const decline = (user, applicationId, body = {}) =>
    request(app).post(`/api/fleet/riders/${applicationId}/reject`).set(authHeader(user)).send(body);

  beforeEach(async () => {
    await resetAllPgTables();

    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    rapidOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });

    rapidRider = await createPgUser({ role: 'rider', organization_id: rapid.id });
    kasiRider = await createPgUser({ role: 'rider', organization_id: kasi.id });

    rapidBike = await createPgBike({ registration: 'RAP001GP', organization_id: rapid.id, status: 'ready_to_go' });
    kasiBike = await createPgBike({ registration: 'KAS001GP', organization_id: kasi.id, status: 'ready_to_go' });

    rapidApp = await applyFor(rapidRider.user.id);
    kasiApp = await applyFor(kasiRider.user.id);
  });

  describe('approving one of its own', () => {
    it('opens an agreement on the allocated bike', async () => {
      const res = await approve(rapidOwner.user, rapidApp.id, {
        bike_id: rapidBike.id, weekly_amount: 900, total_weeks: 52, start_date: todayIso(),
      });
      expect(res.status).toBe(200);
      expect(res.body.agreement_no).toMatch(/\w/);

      const { rows } = await pgDb.query(
        `SELECT user_id, bike_id, weekly_amount, total_weeks, total_amount, status
           FROM agreements WHERE id = $1`, [res.body.agreement_id]);
      expect(rows[0]).toMatchObject({
        user_id: rapidRider.user.id, bike_id: rapidBike.id, status: 'active',
      });
      expect(Number(rows[0].total_weeks)).toBe(52);
      expect(Number(rows[0].weekly_amount)).toBe(900);
      expect(Number(rows[0].total_amount), 'the contract value is the weekly times the term').toBe(46800);
    });

    it('marks the application approved and the bike active', async () => {
      await approve(rapidOwner.user, rapidApp.id, {
        bike_id: rapidBike.id, weekly_amount: 900, total_weeks: 52, start_date: todayIso(),
      });
      const { rows: appRows } = await pgDb.query(
        'SELECT status, reviewed_by, preferred_bike_id FROM applications WHERE id = $1', [rapidApp.id]);
      expect(appRows[0]).toMatchObject({
        status: 'approved', reviewed_by: rapidOwner.user.id, preferred_bike_id: rapidBike.id,
      });

      const { rows: bikeRows } = await pgDb.query('SELECT status FROM bikes WHERE id = $1', [rapidBike.id]);
      expect(bikeRows[0].status).toBe('active');
    });

    // The rider is charged off this schedule, so a missing week is a week
    // nobody bills for.
    it('builds a payment schedule for the whole term', async () => {
      const res = await approve(rapidOwner.user, rapidApp.id, {
        bike_id: rapidBike.id, weekly_amount: 900, total_weeks: 52, start_date: todayIso(),
      });
      const { rows } = await pgDb.query(
        `SELECT COUNT(*)::int n, SUM(amount_due)::numeric total
           FROM payment_schedules WHERE agreement_id = $1`,
        [res.body.agreement_id]);
      expect(rows[0].n).toBe(52);
      expect(Number(rows[0].total)).toBe(46800);
    });

    it('falls back to the bike\'s own terms when none are given', async () => {
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query(
        'SELECT weekly_amount, total_weeks FROM agreements WHERE id = $1', [res.body.agreement_id]);
      expect(Number(rows[0].weekly_amount)).toBe(850);
      expect(Number(rows[0].total_weeks)).toBe(78);
    });

    it('and it is written to the audit log', async () => {
      await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'fleet_owner.rider_application_approve'`);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata).organization_id).toBe(rapid.id);
    });
  });

  describe('what it may not decide', () => {
    it('not another fleet\'s application', async () => {
      const res = await approve(rapidOwner.user, kasiApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(404);

      const { rows } = await pgDb.query('SELECT status FROM applications WHERE id = $1', [kasiApp.id]);
      expect(rows[0].status, 'another fleet\'s application was decided').toBe('submitted');
      const { rows: agreements } = await pgDb.query('SELECT COUNT(*)::int n FROM agreements');
      expect(agreements[0].n).toBe(0);
    });

    it('nor decline one', async () => {
      const res = await decline(rapidOwner.user, kasiApp.id, { reason: 'No' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT status FROM applications WHERE id = $1', [kasiApp.id]);
      expect(rows[0].status).toBe('submitted');
    });

    // The bike is the part that costs money. Naming another fleet's is the
    // mistake that would put their motorcycle on this fleet's contract.
    it('nor allocate another fleet\'s bike', async () => {
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: kasiBike.id });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/Bike not found/);

      const { rows } = await pgDb.query('SELECT status FROM bikes WHERE id = $1', [kasiBike.id]);
      expect(rows[0].status, 'another fleet\'s bike was allocated').toBe('ready_to_go');
    });

    it('and a viewer may not decide at all', async () => {
      const res = await approve(viewer.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(403);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM agreements');
      expect(rows[0].n).toBe(0);
    });

    // Riders are part of the Fleet plan. A fleet that has dropped below it
    // keeps its riders but cannot take on new ones.
    it('nor a fleet whose plan no longer includes riders', async () => {
      await pgDb.query(`UPDATE organizations SET subscription_tier='basic' WHERE id=$1`, [rapid.id]);
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TIER_REQUIRED');
    });
  });

  describe('the states that refuse', () => {
    it('a bike that is not ready to go', async () => {
      await pgDb.query(`UPDATE bikes SET status='repairs' WHERE id=$1`, [rapidBike.id]);
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Ready to go/);
    });

    it('a rider who already has an open agreement', async () => {
      const other = await createPgBike({ organization_id: rapid.id, status: 'active' });
      await createPgAgreement({ bike_id: other.id, user_id: rapidRider.user.id, status: 'active' });
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already has an open agreement/);
    });

    it('a bike that is already on one', async () => {
      const otherRider = await createPgUser({ role: 'rider', organization_id: rapid.id });
      await createPgAgreement({ bike_id: rapidBike.id, user_id: otherRider.user.id, status: 'active' });
      const res = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Bike already has an open agreement/);
    });

    // Twice through the form, or twice through a slow connection, must not be
    // two agreements on one bike.
    it('an application that has already been approved', async () => {
      const first = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(first.status).toBe(200);

      const second = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(second.status).toBe(400);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM agreements');
      expect(rows[0].n, 'one application produced two agreements').toBe(1);
    });

    // The test above passes even without the status check, because the open
    // agreement refuses the second attempt on its own. This is the one that
    // actually tests the check: the first agreement is finished and the bike
    // is free again, so nothing else stands in the way — and a decision that
    // has already been made must still not be made twice.
    it('an application already approved, even once that agreement has ended', async () => {
      const first = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(first.status).toBe(200);
      await pgDb.query(`UPDATE agreements SET status='completed' WHERE id=$1`, [first.body.agreement_id]);
      await pgDb.query(`UPDATE bikes SET status='ready_to_go' WHERE id=$1`, [rapidBike.id]);

      const again = await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/Only submitted or under review/);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM agreements');
      expect(rows[0].n, 'a decided application was decided a second time').toBe(1);
    });

    it('and an approved one cannot then be declined', async () => {
      await approve(rapidOwner.user, rapidApp.id, { bike_id: rapidBike.id });
      const res = await decline(rapidOwner.user, rapidApp.id, { reason: 'Changed my mind' });
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT status FROM applications WHERE id = $1', [rapidApp.id]);
      expect(rows[0].status).toBe('approved');
    });

    it('an application with no bike named anywhere', async () => {
      const res = await approve(rapidOwner.user, rapidApp.id, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/bike_id is required/);
    });
  });

  describe('declining one', () => {
    it('records the reason and tells the rider why', async () => {
      const res = await decline(rapidOwner.user, rapidApp.id, { reason: 'Income below the threshold' });
      expect(res.status).toBe(200);
      const { rows } = await pgDb.query(
        'SELECT status, rejection_reason, reviewed_by FROM applications WHERE id = $1', [rapidApp.id]);
      expect(rows[0]).toMatchObject({
        status: 'rejected',
        rejection_reason: 'Income below the threshold',
        reviewed_by: rapidOwner.user.id,
      });
    });

    it('leaves the bike alone', async () => {
      await pgDb.query('UPDATE applications SET preferred_bike_id = $1 WHERE id = $2', [rapidBike.id, rapidApp.id]);
      await decline(rapidOwner.user, rapidApp.id, { reason: 'Not this time' });
      const { rows } = await pgDb.query('SELECT status FROM bikes WHERE id = $1', [rapidBike.id]);
      expect(rows[0].status).toBe('ready_to_go');
    });
  });

  // A rider applying through a fleet's share link has no organisation of
  // their own until they are taken on; the bike they asked for is the only
  // thing tying them to a fleet. The queue and the decision have to agree
  // about that, or the list hides an application that can be decided.
  describe('an applicant with no fleet of their own', () => {
    let stranger, strangerApp;

    beforeEach(async () => {
      stranger = await createPgUser({ role: 'rider', organization_id: null });
      strangerApp = await applyFor(stranger.user.id, rapidBike.id);
    });

    const queueFor = (user) => request(app).get('/api/fleet/applications').set(authHeader(user));

    it('shows up in the queue of the fleet whose bike they asked for', async () => {
      const res = await queueFor(rapidOwner.user);
      expect(res.body.applications.map((a) => a.id)).toContain(strangerApp.id);
    });

    it('and not in anybody else\'s', async () => {
      const res = await queueFor(kasiOwner.user);
      expect(res.body.applications.map((a) => a.id)).not.toContain(strangerApp.id);
    });

    it('and that fleet can decide it', async () => {
      const res = await approve(rapidOwner.user, strangerApp.id, { bike_id: rapidBike.id });
      expect(res.status).toBe(200);
    });
  });
});
