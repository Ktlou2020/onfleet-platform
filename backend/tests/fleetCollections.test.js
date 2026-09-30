import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Chasing a rider who is behind.
//
// The queue is every agreement with an overdue week on it or that has
// defaulted outright, and against each one a fleet logs what they did: rang,
// sent a notice, went round, gave up. The routes shipped without a test,
// which for the screen that decides whose bike gets immobilised is the wrong
// number.
//
// The part these tests care most about is the follow-up date. A collections
// list that cannot tell today's work from next month's is a list of debts,
// not a queue.

const dayFrom = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!process.env.DATABASE_URL)('a fleet chasing what it is owed', () => {
  let rapid, kasi, owner, billing, viewer, kasiOwner;
  let behind, current, kasiBehind;

  const queue = (user) => request(app).get('/api/fleet/collections').set(authHeader(user));
  const log = (user, agreementId, body) =>
    request(app).post(`/api/fleet/collections/${agreementId}/action`).set(authHeader(user)).send(body);
  const history = (user, agreementId) =>
    request(app).get(`/api/fleet/collections/${agreementId}/actions`).set(authHeader(user));

  // An agreement with weeks nobody paid.
  const owing = async ({ org, registration, weeksOverdue = 3, weekly = 850 }) => {
    const bike = await createPgBike({ registration, organization_id: org.id, status: 'active' });
    const rider = await createPgUser({ role: 'rider', organization_id: org.id });
    const agreement = await createPgAgreement({
      bike_id: bike.id, user_id: rider.user.id, status: 'active', weekly_amount: weekly,
    });
    for (let i = 1; i <= weeksOverdue; i += 1) {
      await pgDb.query(
        `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
         VALUES ($1,$2,$3,$4,0,'overdue')`,
        [agreement.id, i, dayFrom(-7 * (weeksOverdue - i + 1)), weekly]);
    }
    return { ...agreement, bike, rider };
  };

  beforeEach(async () => {
    await resetAllPgTables();
    rapid = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    kasi = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[rapid.id, kasi.id]]);

    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: rapid.id });
    billing = await createPgUser({ role: 'fleet_owner_billing', organization_id: rapid.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: rapid.id });
    kasiOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: kasi.id });

    behind = await owing({ org: rapid, registration: 'RAP001GP', weeksOverdue: 3 });
    kasiBehind = await owing({ org: kasi, registration: 'KAS001GP', weeksOverdue: 2 });

    // Paid up, and therefore none of the queue's business.
    const bike = await createPgBike({ registration: 'RAP002GP', organization_id: rapid.id, status: 'active' });
    const rider = await createPgUser({ role: 'rider', organization_id: rapid.id });
    current = await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active' });
    await pgDb.query(
      `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
       VALUES ($1,1,$2,850,850,'paid')`, [current.id, dayFrom(-7)]);
  });

  describe('the queue', () => {
    it('is the riders who are behind, and nobody else', async () => {
      const res = await queue(owner.user);
      expect(res.status).toBe(200);
      expect(res.body.collections.map((c) => c.id)).toEqual([behind.id]);
    });

    it('adds up what each one owes', async () => {
      const res = await queue(owner.user);
      expect(res.body.collections[0].overdue_balance).toBe(2550);
      expect(res.body.collections[0].days_overdue).toBeGreaterThanOrEqual(21);
    });

    it('starts everyone at pending, with nobody having chased them', async () => {
      const res = await queue(owner.user);
      expect(res.body.collections[0]).toMatchObject({ current_stage: 'pending', never_actioned: true });
    });

    it('and never shows another fleet theirs', async () => {
      const res = await queue(owner.user);
      expect(res.body.collections.map((c) => c.id)).not.toContain(kasiBehind.id);
    });

    it('a defaulted agreement is in it even with nothing overdue', async () => {
      await pgDb.query(`UPDATE agreements SET status='defaulted' WHERE id=$1`, [current.id]);
      const res = await queue(owner.user);
      expect(res.body.collections.map((c) => c.id)).toContain(current.id);
    });

    it('the billing lead may read it', async () => {
      expect((await queue(billing.user)).status).toBe(200);
    });
  });

  describe('logging what was done', () => {
    it('records the call and moves the stage', async () => {
      const res = await log(owner.user, behind.id, {
        stage: 'contacted', action_type: 'call', notes: 'Rang, says he will pay Friday',
        outcome: 'Promise to pay', next_action_date: dayFrom(3),
      });
      expect(res.status).toBe(201);
      expect(res.body.action).toMatchObject({ stage: 'contacted', action_type: 'call' });

      const after = await queue(owner.user);
      expect(after.body.collections[0]).toMatchObject({
        current_stage: 'contacted', never_actioned: false, next_action_date: dayFrom(3), follow_up_due: false,
      });
    });

    // The whole point of the date. Friday comes, the money does not.
    it('and the day it was promised for brings it back to the top', async () => {
      await log(owner.user, behind.id, {
        stage: 'contacted', action_type: 'call', next_action_date: dayFrom(0),
      });
      const res = await queue(owner.user);
      expect(res.body.collections[0].follow_up_due, 'a promise due today is not today\'s work').toBe(true);
    });

    it('a date that has passed counts the same way', async () => {
      await log(owner.user, behind.id, { stage: 'notice_sent', action_type: 'legal_notice', next_action_date: dayFrom(-2) });
      const res = await queue(owner.user);
      expect(res.body.collections[0].follow_up_due).toBe(true);
    });

    // Once it is settled, the date stops nagging.
    it('but a debt marked resolved stops asking', async () => {
      await log(owner.user, behind.id, { stage: 'resolved', action_type: 'note', next_action_date: dayFrom(-2) });
      const res = await queue(owner.user);
      expect(res.body.collections[0]).toMatchObject({ current_stage: 'resolved', follow_up_due: false });
    });

    it('keeps the whole history, newest first', async () => {
      await log(owner.user, behind.id, { stage: 'contacted', action_type: 'call' });
      await log(owner.user, behind.id, { stage: 'notice_sent', action_type: 'legal_notice' });
      const res = await history(owner.user, behind.id);
      expect(res.body.actions.map((a) => a.action_type)).toEqual(['legal_notice', 'call']);
      expect(res.body.actions[0].created_by_name).toBeTruthy();
    });

    it('refuses a stage that is not one', async () => {
      expect((await log(owner.user, behind.id, { stage: 'annoyed', action_type: 'call' })).status).toBe(400);
    });

    it('refuses an action nobody can take', async () => {
      expect((await log(owner.user, behind.id, { stage: 'contacted', action_type: 'telepathy' })).status).toBe(400);
    });

    it('and writes it to the audit log', async () => {
      await log(owner.user, behind.id, { stage: 'contacted', action_type: 'whatsapp' });
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'fleet_owner.collections_action'`);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].metadata).agreement_id).toBe(behind.id);
    });
  });

  describe('who may chase', () => {
    it('not a viewer', async () => {
      expect((await log(viewer.user, behind.id, { stage: 'contacted', action_type: 'call' })).status).toBe(403);
    });

    // Reading the book is part of the billing lead's job; deciding to send
    // somebody round is not.
    it('nor the billing lead', async () => {
      expect((await log(billing.user, behind.id, { stage: 'recovery', action_type: 'repo' })).status).toBe(403);
    });

    it('and never on another fleet\'s rider', async () => {
      const res = await log(owner.user, kasiBehind.id, { stage: 'recovery', action_type: 'repo' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM collections_actions WHERE agreement_id = $1', [kasiBehind.id]);
      expect(rows[0].n, 'a fleet logged a repo against another fleet\'s rider').toBe(0);
    });

    it('nor read another fleet\'s history', async () => {
      await log(kasiOwner.user, kasiBehind.id, { stage: 'contacted', action_type: 'call', notes: 'Private' });
      const res = await history(owner.user, kasiBehind.id);
      expect(res.status).toBe(404);
    });
  });
});
