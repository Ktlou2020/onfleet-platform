import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';
import buildApp from '../src/app.js';
import { pgDb, resetAllPgTables, createPgUser, authHeader } from './helpers/testPgDb.js';

const { queueAlert } = createRequire(import.meta.url)('../src/services/webhookDispatcher.js');
const app = buildApp();

// Each webhook can be told which alert types to receive. Without it the
// control room got every alert, and 1,073 of about 1,150 in a month were idle.
describe.skipIf(!process.env.DATABASE_URL)('choosing which alerts a webhook receives', () => {
  let superadmin;
  let hookId;
  const put = (body, user = superadmin) =>
    request(app).put(`/api/admin/integrations/webhooks/${hookId}`).set(authHeader(user)).send(body);
  const alert = (id, type) => ({ id, alert_type: type, severity: null, payload: {}, created_at: new Date().toISOString() });
  const deliveries = async () => Number((await pgDb.query('SELECT COUNT(*) AS n FROM webhook_deliveries')).rows[0].n);

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = (await createPgUser({ role: 'superadmin' })).user;
    // Unroutable on purpose: queueing starts a delivery attempt, which should fail fast and harmlessly.
    const { rows } = await pgDb.query(
      `INSERT INTO webhook_endpoints (name, url, secret, scope, active)
       VALUES ('Control Room', 'https://127.0.0.1:9/hook', 'whsec_test', 'platform', TRUE) RETURNING id`);
    hookId = rows[0].id;
  });

  it('stops sending alert types that are not selected', async () => {
    expect((await put({ event_types: ['tamper', 'panic'] })).status).toBe(200);
    expect(await queueAlert(alert(101, 'idle'))).toBe(0);
    expect(await queueAlert(alert(102, 'tamper'))).toBe(1);
    expect(await deliveries()).toBe(1);
  });

  it('goes back to every type, including ones added later, when set to all', async () => {
    await put({ event_types: ['tamper'] });
    expect((await put({ event_types: null })).status).toBe(200);
    const { rows } = await pgDb.query('SELECT event_types FROM webhook_endpoints WHERE id = $1', [hookId]);
    expect(rows[0].event_types).toBeNull();
    expect(await queueAlert(alert(103, 'idle'))).toBe(1);
  });

  it('stores the selection in catalogue order, without duplicates', async () => {
    const res = await put({ event_types: ['geofence_exit', 'panic', 'panic'] });
    expect(res.body.webhook.event_types).toBe('panic,geofence_exit');
  });

  it('refuses an empty selection and points to Pause instead', async () => {
    const res = await put({ event_types: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pause/i);
  });

  it('refuses alert types that do not exist', async () => {
    const res = await put({ event_types: ['tamper', 'teleport'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/teleport/);
  });

  it('keeps pausing and resuming working on their own', async () => {
    await put({ event_types: ['tamper'] });
    const res = await put({ active: false });
    expect(res.body.webhook).toMatchObject({ active: false, event_types: 'tamper' });
  });

  it('records the before and after of every change', async () => {
    await put({ event_types: ['tamper'] });
    const { rows } = await pgDb.query(`SELECT metadata FROM audit_logs WHERE action = 'admin.webhook_update'`);
    const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(meta).toMatchObject({ before: { event_types: null }, after: { event_types: 'tamper' } });
  });

  it('lists every alert type with its severity and recent volume', async () => {
    const res = await request(app).get('/api/admin/integrations/alert-types').set(authHeader(superadmin));
    expect(res.status).toBe(200);
    expect(res.body.alert_types.find((t) => t.type === 'idle')).toMatchObject({ severity: 'low', last_30_days: 0 });
    expect(res.body.alert_types.find((t) => t.type === 'panic')).toMatchObject({ severity: 'critical' });
  });

  it('validates the choice when a webhook is created, too', async () => {
    const res = await request(app).post('/api/admin/integrations/webhooks').set(authHeader(superadmin))
      .send({ name: 'Other', url: 'https://example.test/hook', event_types: ['nonsense'] });
    expect(res.status).toBe(400);
  });

  it('leaves the choice to superadmins', async () => {
    const admin = (await createPgUser({ role: 'admin' })).user;
    expect((await put({ event_types: ['tamper'] }, admin)).status).toBe(403);
    expect((await request(app).get('/api/admin/integrations/alert-types').set(authHeader(admin))).status).toBe(403);
  });
});
