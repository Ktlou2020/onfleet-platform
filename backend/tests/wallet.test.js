import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import buildApp from '../src/app.js';
import { db, resetAllTables, createOrg, createUser, authHeader } from './helpers/testDb.js';

const app = buildApp();

let superadmin;
let admin;

beforeEach(() => {
  resetAllTables();
  superadmin = createUser({ role: 'superadmin' }).user;
  admin = createUser({ role: 'admin' }).user;
});

describe('POST /api/admin/organizations/:id/wallet-adjustment', () => {
  it('credits a positive amount and returns the new balance', async () => {
    const org = createOrg();

    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 250, reason: 'Goodwill credit for a service delay' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.balance).toBe(250);

    const wallet = db.prepare('SELECT * FROM fleet_wallets WHERE organization_id = ?').get(org.id);
    expect(wallet.balance).toBe(250);
  });

  it('debits with a negative amount', async () => {
    const org = createOrg();
    db.prepare('INSERT INTO fleet_wallets (organization_id, balance) VALUES (?, ?)').run(org.id, 500);

    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: -120, reason: 'Correcting a duplicate credit' });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(380);
  });

  it('allows the balance to go negative (no floor enforced)', async () => {
    const org = createOrg();
    db.prepare('INSERT INTO fleet_wallets (organization_id, balance) VALUES (?, ?)').run(org.id, 50);

    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: -200, reason: 'Clawback for a reversed payment' });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(-150);
  });

  it('writes a ledger row with type=adjustment, no fee, and the actor recorded', async () => {
    const org = createOrg();

    await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 100, reason: 'Manual top-up' });

    const txn = db.prepare('SELECT * FROM fleet_wallet_transactions WHERE organization_id = ?').get(org.id);
    expect(txn.type).toBe('adjustment');
    expect(txn.amount).toBe(100);
    expect(txn.fee_amount).toBe(0);
    expect(txn.net_amount).toBe(100);
    expect(txn.description).toBe('Manual top-up');
    expect(txn.actor_user_id).toBe(superadmin.id);
    // no 48h hold like automated credits — available immediately
    expect(txn.available_at).toBeNull();
  });

  it('writes an audit_logs entry', async () => {
    const org = createOrg();

    await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 75, reason: 'Test audit trail' });

    const entry = db.prepare(`SELECT * FROM audit_logs WHERE action = 'wallet.manual_adjustment' AND entity_id = ?`).get(org.id);
    expect(entry).toBeTruthy();
    expect(entry.actor_id).toBe(superadmin.id);
    const metadata = JSON.parse(entry.metadata);
    expect(metadata.amount).toBe(75);
    expect(metadata.reason).toBe('Test audit trail');
  });

  it('rejects a zero amount', async () => {
    const org = createOrg();
    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 0, reason: 'Should not go through' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing/blank reason', async () => {
    const org = createOrg();
    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 100, reason: '   ' });
    expect(res.status).toBe(400);

    const wallet = db.prepare('SELECT * FROM fleet_wallets WHERE organization_id = ?').get(org.id);
    expect(wallet).toBeFalsy(); // nothing should have been written
  });

  it('rejects a non-existent organization', async () => {
    const res = await request(app)
      .post('/api/admin/organizations/999999/wallet-adjustment')
      .set(authHeader(superadmin))
      .send({ amount: 100, reason: 'Org does not exist' });
    expect(res.status).toBe(404);
  });

  it('rejects a plain admin (superadmin-only route)', async () => {
    const org = createOrg();
    const res = await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(admin))
      .send({ amount: 100, reason: 'Should be forbidden' });
    expect(res.status).toBe(403);
  });

  it('accumulates correctly across multiple adjustments', async () => {
    const org = createOrg();

    await request(app).post(`/api/admin/organizations/${org.id}/wallet-adjustment`).set(authHeader(superadmin)).send({ amount: 100, reason: 'first' });
    await request(app).post(`/api/admin/organizations/${org.id}/wallet-adjustment`).set(authHeader(superadmin)).send({ amount: -30, reason: 'second' });
    const res = await request(app).post(`/api/admin/organizations/${org.id}/wallet-adjustment`).set(authHeader(superadmin)).send({ amount: 50, reason: 'third' });

    expect(res.body.balance).toBe(120);
    const count = db.prepare('SELECT COUNT(*) n FROM fleet_wallet_transactions WHERE organization_id = ?').get(org.id).n;
    expect(count).toBe(3);
  });
});

describe('GET /api/admin/organizations/:id/wallet', () => {
  it('returns a zeroed wallet for an org with no fleet_wallets row yet', async () => {
    const org = createOrg();
    const res = await request(app)
      .get(`/api/admin/organizations/${org.id}/wallet`)
      .set(authHeader(superadmin));
    expect(res.status).toBe(200);
    expect(res.body.wallet.balance).toBe(0);
    expect(res.body.transactions).toEqual([]);
  });

  it('returns balance and recent transactions after an adjustment', async () => {
    const org = createOrg();
    await request(app)
      .post(`/api/admin/organizations/${org.id}/wallet-adjustment`)
      .set(authHeader(superadmin))
      .send({ amount: 200, reason: 'Setup credit' });

    const res = await request(app)
      .get(`/api/admin/organizations/${org.id}/wallet`)
      .set(authHeader(superadmin));

    expect(res.status).toBe(200);
    expect(res.body.wallet.balance).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].type).toBe('adjustment');
  });

  it('rejects a plain admin', async () => {
    const org = createOrg();
    const res = await request(app)
      .get(`/api/admin/organizations/${org.id}/wallet`)
      .set(authHeader(admin));
    expect(res.status).toBe(403);
  });
});
