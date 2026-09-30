import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike, createPgAgreement, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Sending the reminder, rather than recording that somebody sent one.
//
// The action log has always had 'sms' and 'whatsapp' among its types, but
// they meant "I picked up my phone and did this myself". The platform sent
// nothing and the history was somebody's word for it.
//
// No provider is configured in the tests, so nothing leaves the building —
// which is exactly the case worth pinning down, because a reminder that could
// not be delivered must not be written down as one that was.

const dayAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!process.env.DATABASE_URL)('reminding a rider who is behind', () => {
  let org, owner, viewer, rider, agreement, otherOrg, otherOwner;

  const remind = (user, id, body = {}) =>
    request(app).post(`/api/fleet/collections/${id}/remind`).set(authHeader(user)).send(body);

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg({ name: 'Rapid Wheels', slug: 'rapid-wheels' });
    otherOrg = await createPgOrg({ name: 'Kasi Couriers', slug: 'kasi-couriers' });
    await pgDb.query(
      `UPDATE organizations SET subscription_tier='complete', status='active' WHERE id = ANY($1)`,
      [[org.id, otherOrg.id]]);

    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });
    viewer = await createPgUser({ role: 'fleet_owner_viewer', organization_id: org.id });
    otherOwner = await createPgUser({ role: 'fleet_owner_admin', organization_id: otherOrg.id });
    rider = await createPgUser({ role: 'rider', organization_id: org.id, phone: '0821234567' });

    const bike = await createPgBike({ registration: 'RAP001GP', organization_id: org.id });
    agreement = await createPgAgreement({ bike_id: bike.id, user_id: rider.user.id, status: 'active', weekly_amount: 850 });
    for (let i = 1; i <= 3; i += 1) {
      await pgDb.query(
        `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due, amount_paid, status)
         VALUES ($1,$2,$3,850,0,'overdue')`, [agreement.id, i, dayAgo(7 * i)]);
    }
  });

  it('writes the arrears into the message, in the fleet\'s name', async () => {
    const res = await remind(owner.user, agreement.id, { channel: 'sms' });
    expect([201, 202]).toContain(res.status);

    const { rows } = await pgDb.query(
      `SELECT message, channel, type, entity_id FROM notifications WHERE type = 'payment_overdue'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain('R2550.00');
    expect(rows[0].message).toContain(agreement.agreement_no);
    expect(rows[0].message).toContain('3 weeks');
    // The rider has an agreement with the fleet and has never heard of the
    // company whose software sends this.
    expect(rows[0].message).toContain('Rapid Wheels');
    expect(rows[0]).toMatchObject({ channel: 'sms', entity_id: agreement.id });
  });

  // The point of the whole thing: the history stops being somebody's word.
  it('and logs it against the debt by itself', async () => {
    await remind(owner.user, agreement.id, { channel: 'whatsapp' });
    const { rows } = await pgDb.query(
      'SELECT action_type, stage, outcome, created_by FROM collections_actions WHERE agreement_id = $1',
      [agreement.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action_type: 'whatsapp', stage: 'contacted', created_by: owner.user.id });
  });

  // No provider is configured here, so this is the honest outcome, and it is
  // the one that must not read as "reminded".
  it('says so when nothing could be delivered', async () => {
    const res = await remind(owner.user, agreement.id, { channel: 'sms' });
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(false);
    expect(res.body.outcome).toMatch(/Not delivered/);

    const { rows } = await pgDb.query('SELECT outcome FROM collections_actions WHERE agreement_id = $1', [agreement.id]);
    expect(rows[0].outcome, 'an undelivered reminder was written down as delivered').toMatch(/Not delivered/);
  });

  it('and names the missing detail when the rider has no phone', async () => {
    await pgDb.query('UPDATE users SET phone = NULL WHERE id = $1', [rider.user.id]);
    const res = await remind(owner.user, agreement.id, { channel: 'sms' });
    expect(res.body.outcome).toMatch(/no phone number on file/i);
  });

  describe('what it refuses', () => {
    it('a second reminder the same day', async () => {
      await remind(owner.user, agreement.id, { channel: 'sms' });
      const again = await remind(owner.user, agreement.id, { channel: 'sms' });
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('ALREADY_REMINDED');

      const { rows } = await pgDb.query(
        'SELECT COUNT(*)::int n FROM notifications WHERE type = $1', ['payment_overdue']);
      expect(rows[0].n, 'a rider was chased twice in a day').toBe(1);
    });

    // Deliberately possible, because somebody who has just spoken to the rider
    // may have a reason. It takes saying so.
    it('unless it is asked for deliberately', async () => {
      await remind(owner.user, agreement.id, { channel: 'sms' });
      const again = await remind(owner.user, agreement.id, { channel: 'sms', anyway: true });
      expect([201, 202]).toContain(again.status);
    });

    it('a rider who owes nothing', async () => {
      await pgDb.query(`UPDATE payment_schedules SET status = 'paid', amount_paid = amount_due WHERE agreement_id = $1`, [agreement.id]);
      const res = await remind(owner.user, agreement.id, { channel: 'sms' });
      expect(res.status).toBe(400);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM notifications');
      expect(rows[0].n).toBe(0);
    });

    it('a channel that is not one', async () => {
      expect((await remind(owner.user, agreement.id, { channel: 'carrier pigeon' })).status).toBe(400);
    });

    it('a viewer', async () => {
      expect((await remind(viewer.user, agreement.id, { channel: 'sms' })).status).toBe(403);
    });

    it('and another fleet\'s rider', async () => {
      const res = await remind(otherOwner.user, agreement.id, { channel: 'sms' });
      expect(res.status).toBe(404);
      const { rows } = await pgDb.query('SELECT COUNT(*)::int n FROM notifications');
      expect(rows[0].n, 'a fleet messaged another fleet\'s rider').toBe(0);
    });
  });

  it('and it is written to the audit log', async () => {
    await remind(owner.user, agreement.id, { channel: 'sms' });
    const { rows } = await pgDb.query(
      `SELECT metadata FROM audit_logs WHERE action = 'fleet_owner.collections_reminder'`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ channel: 'sms', organization_id: org.id });
  });
});
