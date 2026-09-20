import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, createPgBike, createPgAlert, authHeader } from './helpers/testPgDb.js';

const app = buildApp();

// Closing an alert demanded a typed comment, so in 30 days not one of 1,169
// alerts was closed. An outcome is one tap; the note is optional.
describe.skipIf(!process.env.DATABASE_URL)('closing alerts with an outcome', () => {
  let admin;
  let alert;
  const close = (body, id = alert.id) => request(app).put(`/api/tracking/alerts/${id}/resolve`).set(authHeader(admin)).send(body);
  const row = async (id = alert.id) => (await pgDb.query('SELECT * FROM tracking_alerts WHERE id=$1', [id])).rows[0];

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    const bike = await createPgBike({ registration: 'LW78MDGP' });
    alert = await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' });
  });

  it('closes on an outcome alone, with no comment', async () => {
    const res = await close({ outcome: 'false_alarm' });
    expect(res.status).toBe(200);
    const after = await row();
    expect(after.resolution_outcome).toBe('false_alarm');
    expect(after.resolved_by).toBe(admin.id);
    expect(after.resolved_at).toBeTruthy();
    // Closing counts as seeing it, and that is now attributed
    expect(after.acknowledged_at).toBeTruthy();
    expect(after.acknowledged_by).toBe(admin.id);
  });

  it('still closes on a comment alone, as it always did', async () => {
    expect((await close({ comment: 'Rider called in, all fine' })).status).toBe(200);
    const after = await row();
    expect(after.resolution_comment).toBe('Rider called in, all fine');
    expect(after.resolution_outcome).toBeNull();
  });

  it('refuses an empty close and an unknown outcome', async () => {
    const empty = await close({});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/outcome/i);
    const bogus = await close({ outcome: 'stolen_by_aliens' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toMatch(/stolen_by_aliens/);
    expect((await row()).resolved_at).toBeNull();
  });

  it('records the outcome in the audit log', async () => {
    await close({ outcome: 'bike_recovered', comment: 'Found in Alexandra' });
    const { rows } = await pgDb.query(`SELECT actor_id, metadata FROM audit_logs WHERE action = 'alert.resolve'`);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ outcome: 'bike_recovered', comment: 'Found in Alexandra' });
  });

  it('closes many alerts with one outcome', async () => {
    const bike = await createPgBike();
    const second = await createPgAlert({ bike_id: bike.id, alert_type: 'idle' });
    const res = await request(app).post('/api/tracking/alerts/resolve-bulk').set(authHeader(admin))
      .send({ ids: [alert.id, second.id], outcome: 'false_alarm' });
    expect(res.status).toBe(200);
    expect(res.body.resolved_count).toBe(2);
    expect((await row(second.id)).resolution_outcome).toBe('false_alarm');
  });

  it('reports how the last 30 days were closed', async () => {
    await close({ outcome: 'bike_recovered' });
    const res = await request(app).get('/api/tracking/alerts/outcomes').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.outcomes.map((o) => o.id)).toContain('police_escalated');
    expect(res.body.totals).toMatchObject({ raised: 1, closed: 1, real_events: 1 });
    expect(res.body.counts).toContainEqual({ outcome: 'bike_recovered', count: 1 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('acknowledging an alert', () => {
  let admin;
  let alert;

  beforeEach(async () => {
    await resetAllPgTables();
    admin = (await createPgUser({ role: 'admin' })).user;
    const bike = await createPgBike();
    alert = await createPgAlert({ bike_id: bike.id, alert_type: 'tamper' });
  });

  // Acknowledging is what stops a critical alert escalating, so it must say who.
  it('records who acknowledged, once, and audits it', async () => {
    const other = (await createPgUser({ role: 'superadmin' })).user;
    expect((await request(app).put(`/api/tracking/alerts/${alert.id}/acknowledge`).set(authHeader(admin))).status).toBe(200);
    const first = (await pgDb.query('SELECT * FROM tracking_alerts WHERE id=$1', [alert.id])).rows[0];
    expect(first.acknowledged_by).toBe(admin.id);

    // A second acknowledgement doesn't rewrite who got there first
    await request(app).put(`/api/tracking/alerts/${alert.id}/acknowledge`).set(authHeader(other));
    const second = (await pgDb.query('SELECT acknowledged_by, acknowledged_at FROM tracking_alerts WHERE id=$1', [alert.id])).rows[0];
    expect(second.acknowledged_by).toBe(admin.id);
    expect(second.acknowledged_at).toEqual(first.acknowledged_at);

    const { rows: audits } = await pgDb.query(`SELECT actor_id FROM audit_logs WHERE action = 'alert.acknowledge'`);
    expect(audits.map((a) => a.actor_id)).toEqual([admin.id]);
  });

  it('records who acknowledged everything at once', async () => {
    const res = await request(app).post('/api/tracking/alerts/acknowledge-all').set(authHeader(admin)).send({});
    expect(res.status).toBe(200);
    const after = (await pgDb.query('SELECT acknowledged_by FROM tracking_alerts WHERE id=$1', [alert.id])).rows[0];
    expect(after.acknowledged_by).toBe(admin.id);
    const { rows } = await pgDb.query(`SELECT metadata FROM audit_logs WHERE action = 'alert.acknowledge_all'`);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ acknowledged: 1 });
  });
});
