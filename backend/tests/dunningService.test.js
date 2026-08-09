import { describe, it, expect, beforeEach } from 'vitest';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, createPgBike,
  createPgAgreement, createPgPaymentSchedule,
} from './helpers/testPgDb.js';
import { runAutomatedDunning } from '../src/services/dunningService.js';

// Needs a real Postgres database (see tests/README.md) — skips cleanly
// without one so `npm test` still runs green with no Postgres configured.
describe.skipIf(!process.env.DATABASE_URL)('runAutomatedDunning', () => {
  let org, admin, bike;

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg();
    ({ user: admin } = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id }));
    bike = await createPgBike({ organization_id: org.id });
  });

  async function overdueAgreement(daysOverdue) {
    const agreement = await createPgAgreement({ bike_id: bike.id });
    const dueDate = new Date(Date.now() - daysOverdue * 86400000).toISOString().slice(0, 10);
    await createPgPaymentSchedule({ agreement_id: agreement.id, due_date: dueDate, status: 'overdue' });
    return agreement;
  }

  async function actionsFor(agreementId) {
    const { rows } = await pgDb.query('SELECT * FROM collections_actions WHERE agreement_id = $1', [agreementId]);
    return rows;
  }

  it('does nothing for an agreement under 7 days overdue', async () => {
    const agreement = await overdueAgreement(3);
    await runAutomatedDunning();
    expect(await actionsFor(agreement.id)).toHaveLength(0);
  });

  it('escalates to "contacted" at 7-13 days overdue', async () => {
    const agreement = await overdueAgreement(10);
    await runAutomatedDunning();
    const actions = await actionsFor(agreement.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].stage).toBe('contacted');
    expect(actions[0].created_by).toBe(admin.id);
  });

  it('escalates to "notice_sent" at 14-20 days overdue', async () => {
    const agreement = await overdueAgreement(15);
    await runAutomatedDunning();
    const actions = await actionsFor(agreement.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].stage).toBe('notice_sent');
  });

  it('escalates to "recovery" at 21+ days overdue', async () => {
    const agreement = await overdueAgreement(25);
    await runAutomatedDunning();
    const actions = await actionsFor(agreement.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].stage).toBe('recovery');
    expect(actions[0].action_type).toBe('note');
  });

  it('never reopens a case a human has already marked resolved', async () => {
    const agreement = await overdueAgreement(25);
    await pgDb.query(
      `INSERT INTO collections_actions (agreement_id, organization_id, stage, action_type, notes, created_by, created_at)
       VALUES ($1,$2,'resolved','note','Manually resolved by staff',$3, NOW() - INTERVAL '1 day')`,
      [agreement.id, org.id, admin.id]
    );
    await runAutomatedDunning();
    const actions = await actionsFor(agreement.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].stage).toBe('resolved');
  });

  it('does not fire twice for the same agreement on the same day', async () => {
    const agreement = await overdueAgreement(10);
    await runAutomatedDunning();
    await runAutomatedDunning();
    expect(await actionsFor(agreement.id)).toHaveLength(1);
  });

  it('does not re-escalate past a stage a human already advanced to', async () => {
    const agreement = await overdueAgreement(10); // would auto-target 'contacted'
    await pgDb.query(
      `INSERT INTO collections_actions (agreement_id, organization_id, stage, action_type, created_by, created_at)
       VALUES ($1,$2,'notice_sent','call',$3, NOW() - INTERVAL '1 day')`,
      [agreement.id, org.id, admin.id]
    );
    await runAutomatedDunning();
    const actions = await actionsFor(agreement.id);
    expect(actions).toHaveLength(1); // still just the human's action — not overwritten by a lower automated stage
    expect(actions[0].stage).toBe('notice_sent');
  });

  it('skips an org with no fleet_owner_admin to attribute the action to', async () => {
    const otherOrg = await createPgOrg();
    const otherBike = await createPgBike({ organization_id: otherOrg.id });
    const agreement = await createPgAgreement({ bike_id: otherBike.id });
    const dueDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    await createPgPaymentSchedule({ agreement_id: agreement.id, due_date: dueDate, status: 'overdue' });

    await runAutomatedDunning();
    expect(await actionsFor(agreement.id)).toHaveLength(0);
  });

  it('ignores platform-direct agreements (bike with no organization)', async () => {
    const directBike = await createPgBike({ organization_id: null });
    const agreement = await createPgAgreement({ bike_id: directBike.id });
    const dueDate = new Date(Date.now() - 25 * 86400000).toISOString().slice(0, 10);
    await createPgPaymentSchedule({ agreement_id: agreement.id, due_date: dueDate, status: 'overdue' });

    await runAutomatedDunning();
    expect(await actionsFor(agreement.id)).toHaveLength(0);
  });
});
