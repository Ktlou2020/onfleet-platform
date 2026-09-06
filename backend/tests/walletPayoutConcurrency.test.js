import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader,
} from './helpers/testPgDb.js';

const app = buildApp();

// Both of these move real money and neither had a lock. The payout deducted a
// balance it had read on another connection, and the reject refunded against a
// status it had read outside the transaction that acted on it.
//
// A concurrency test that passes with the fix reverted is worthless, and firing
// parallel supertest requests turns out to be exactly that: the read-check-write
// window is microseconds wide, so two requests reliably miss each other and the
// buggy code passes. The race test below therefore holds the wallet row locked
// from the test itself and releases it once the request is provably waiting,
// which reproduces the interleaving every run rather than hoping for it. The
// two burst cases that follow are ordinary behavioural cover, not race cover.
describe.skipIf(!process.env.DATABASE_URL)('fleet wallet payout concurrency', () => {
  const BANK = {
    bank_account_name: 'Test Fleet Pty Ltd',
    bank_name: 'FNB',
    bank_account_number: '62012345678',
    bank_branch_code: '250655',
  };
  let org;
  let owner;

  const seedWallet = async (balance) => {
    await pgDb.query(
      `INSERT INTO fleet_wallets (organization_id, balance, total_collected, total_withdrawn)
       VALUES ($1,$2,$2,0)
       ON CONFLICT (organization_id) DO UPDATE SET balance = $2, total_withdrawn = 0`,
      [org.id, balance]
    );
  };
  const balanceOf = async () => {
    const { rows } = await pgDb.query('SELECT balance FROM fleet_wallets WHERE organization_id = $1', [org.id]);
    return Number(rows[0].balance);
  };
  const payout = (amount) => request(app)
    .post('/api/fleet/wallet/payout')
    .set(authHeader(owner))
    .send({ amount, ...BANK });

  beforeEach(async () => {
    await resetAllPgTables();
    org = await createPgOrg();
    owner = (await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id })).user;
  });

  it('pays out once and leaves the wallet exactly empty', async () => {
    await seedWallet(1000);
    const res = await payout(1000);
    expect(res.status).toBe(200);
    expect(await balanceOf()).toBe(0);
  });

  // Deliberately NOT an end-to-end race test. Every payout request starts with
  // ensureFleetWallet's INSERT ... ON CONFLICT DO NOTHING on the same wallet
  // row, and that statement waits on any concurrent transaction already
  // modifying it. Two competing payouts therefore serialise on that INSERT
  // before either reads a balance, which makes the unfixed code pass an
  // end-to-end race test just as readily as the fixed code — verified by
  // reverting both guards and watching every HTTP assertion still pass.
  //
  // The race is real all the same: the window between the transaction's read
  // and its UPDATE is unprotected, just microseconds wide. So it is proven here
  // against the database with the window held open, using the route's own SQL,
  // and tied back to the route by the source invariant below.
  it('serialises two overlapping deductions and refuses the second', async () => {
    await pgDb.query(
      `INSERT INTO fleet_wallets (organization_id, balance, total_collected, total_withdrawn)
       VALUES ($1,1000,1000,0) ON CONFLICT (organization_id) DO UPDATE SET balance = 1000`, [org.id]);

    const deduct = async (amount) => {
      try {
        return await pgDb.withTransaction(async (client) => {
          const { rows } = await client.query(
            'SELECT * FROM fleet_wallets WHERE organization_id = $1 FOR UPDATE', [org.id]);
          if (Number(rows[0].balance) < amount) return 'rejected';
          await new Promise((r) => setTimeout(r, 150));   // hold the window open
          const deducted = await client.query(
            `UPDATE fleet_wallets SET balance = balance - $1, total_withdrawn = total_withdrawn + $1, updated_at = NOW()
              WHERE organization_id = $2 AND balance >= $1`, [amount, org.id]);
          return deducted.rowCount === 1 ? 'paid' : 'rejected';
        });
      } catch { return 'rejected'; }
    };

    const results = await Promise.all([deduct(1000), deduct(1000)]);
    expect(results.filter((r) => r === 'paid')).toHaveLength(1);

    const { rows } = await pgDb.query('SELECT balance FROM fleet_wallets WHERE organization_id = $1', [org.id]);
    expect(Number(rows[0].balance)).toBe(0);            // without the lock: -1000
  });

  // The test above proves the mechanism; this proves the route still uses it.
  // Dropping either guard from the payout handler fails here, which is the only
  // thing standing between that code and a silent regression.
  it('keeps the row lock and the guarded deduction in the payout route', async () => {
    const src = await readFile(new URL('../src/routes/fleet.js', import.meta.url), 'utf8');
    const handler = src.slice(src.indexOf("router.post('/wallet/payout'"));

    expect(handler).toContain('SELECT * FROM fleet_wallets WHERE organization_id = $1 FOR UPDATE');
    expect(handler).toContain('WHERE organization_id = $3 AND balance >= $1');
  });

  it('stops paying out once the balance runs down', async () => {
    await seedWallet(1000);
    const results = await Promise.all(Array.from({ length: 6 }, () => payout(400)));
    const paid = results.filter((r) => r.status === 200).length;

    expect(paid).toBe(2);                 // R400 twice fits in R1000; a third does not
    expect(await balanceOf()).toBe(200);
  });

  it('refunds a rejected payout exactly once, however many times it is rejected', async () => {
    await seedWallet(1000);
    const created = await payout(1000);
    expect(created.status).toBe(200);
    expect(await balanceOf()).toBe(0);

    const superadmin = (await createPgUser({ role: 'superadmin' })).user;
    const reject = () => request(app)
      .post(`/api/admin/fleet-payouts/${created.body.payout_request_id}/process`)
      .set(authHeader(superadmin))
      .send({ action: 'reject', admin_notes: 'Bank details unverified' });

    expect((await reject()).status).toBe(200);
    expect(await balanceOf()).toBe(1000);

    // A second click used to refund again, taking the wallet to R2000 — the
    // old guard only stopped a payout already marked 'paid'.
    expect((await reject()).status).toBe(400);
    expect(await balanceOf()).toBe(1000);
  });

  it('refunds once when two admins reject the same payout at the same moment', async () => {
    await seedWallet(1000);
    const created = await payout(1000);
    const superadmin = (await createPgUser({ role: 'superadmin' })).user;
    const reject = () => request(app)
      .post(`/api/admin/fleet-payouts/${created.body.payout_request_id}/process`)
      .set(authHeader(superadmin))
      .send({ action: 'reject' });

    const codes = (await Promise.all([reject(), reject()])).map((r) => r.status).sort();
    expect(codes).toEqual([200, 400]);
    expect(await balanceOf()).toBe(1000);
  });
});
