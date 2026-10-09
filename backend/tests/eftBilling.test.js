import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import buildApp from '../src/app.js';
import {
  pgDb, resetAllPgTables, createPgOrg, createPgUser, authHeader,
} from './helpers/testPgDb.js';

const require_ = createRequire(import.meta.url);
const billing = require_('../src/services/subscriptionBilling.js');
const dunning = require_('../src/services/subscriptionDunning.js');
const app = buildApp();

// Clients who pay by bank transfer.
//
// The bug this exists to fix is not "EFT is unsupported". It is that an EFT
// client was actively broken by the card machinery: their trial ended, the
// fleet gate flipped them to past_due on the next request and locked them
// out, and the billing run skipped them for having no card — so nothing ever
// raised an invoice and nothing could ever let them back in. They could pay
// the full amount that morning and the platform would never know.
//
// So the tests that matter most here are about who gets blocked and when.

const dayOffset = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!process.env.DATABASE_URL)('EFT billing', () => {
  let superadmin, org, owner;

  const setOrg = (fields) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    return pgDb.query(`UPDATE organizations SET ${sets} WHERE id = $1`, [org.id, ...keys.map((k) => fields[k])]);
  };

  const orgRow = async () => {
    const { rows } = await pgDb.query('SELECT * FROM organizations WHERE id = $1', [org.id]);
    return rows[0];
  };

  const invoices = async () => {
    const { rows } = await pgDb.query(
      'SELECT * FROM subscription_invoices WHERE organization_id = $1 ORDER BY id', [org.id]);
    return rows;
  };

  beforeEach(async () => {
    await resetAllPgTables();
    superadmin = await createPgUser({ role: 'superadmin' });
    org = await createPgOrg({ name: 'Kasi Couriers' });
    owner = await createPgUser({ role: 'fleet_owner_admin', organization_id: org.id });
    await setOrg({
      subscription_tier: 'fleet', subscription_cycle: 'monthly',
      subscription_status: 'active', status: 'active', billing_method: 'eft',
      next_billing_date: dayOffset(-1), billing_email: 'billing@kasi.test',
    });
    // Nothing in these tests may reach Paystack.
    vi.spyOn(billing, 'chargeOrganization');
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('the billing run', () => {
    it('invoices an EFT client that has no card', async () => {
      const result = await billing.runBillingRun({});
      const raised = await invoices();

      expect(raised, 'an EFT client was skipped for having no card, so was never invoiced').toHaveLength(1);
      expect(raised[0].status).toBe('pending');
      expect(result.charges[0].awaiting_eft).toBe(true);
    });

    it('never presents a card for them', async () => {
      await billing.runBillingRun({});
      const raised = await invoices();
      // A charge would have marked it paid or failed. Pending is the proof
      // that nothing was presented and nothing was declined.
      expect(raised[0].status).toBe('pending');
      expect(raised[0].failure_reason).toBeNull();
    });

    it('does not mark them past_due merely for not having paid yet', async () => {
      await billing.runBillingRun({});
      const after = await orgRow();
      expect(after.subscription_status, 'an unpaid invoice on day one was treated as arrears').toBe('active');
      expect(after.status).toBe('active');
    });

    it('sets a payment terms date they can be told about', async () => {
      await billing.runBillingRun({});
      const after = await orgRow();
      expect(after.billing_grace_until).toBeTruthy();
    });

    it('invoices once per period however often the run fires', async () => {
      await billing.runBillingRun({});
      await billing.runBillingRun({});
      expect(await invoices()).toHaveLength(1);
    });

    // A card client with no card is not due at all — organizationsDue has
    // always required an authorization — so the EFT path must not quietly
    // start invoicing them instead.
    it('leaves a card client alone rather than invoicing them', async () => {
      await setOrg({ billing_method: 'card' });
      const result = await billing.runBillingRun({});
      expect(result.charges).toHaveLength(0);
      expect(await invoices(), 'a card client was invoiced through the EFT path').toHaveLength(0);
    });
  });

  describe('who gets blocked', () => {
    // The original bug, from the fleet gate's own point of view.
    it('an EFT client whose trial ended is not locked out', async () => {
      await setOrg({ status: 'trialing', trial_ends_at: dayOffset(-1), subscription_status: 'active' });

      const res = await request(app).get('/api/fleet/portal-data').set(authHeader(owner.user));
      expect(res.status, 'an EFT client was paywalled the moment their trial ended').not.toBe(402);

      const after = await orgRow();
      expect(after.status).toBe('active');
    });

    it('a card client whose trial ended still is', async () => {
      await setOrg({ billing_method: 'card', status: 'trialing', trial_ends_at: dayOffset(-1) });
      const res = await request(app).get('/api/fleet/portal-data').set(authHeader(owner.user));
      expect(res.status).toBe(402);
    });

    it('a hold keeps a past_due account open', async () => {
      await setOrg({ status: 'past_due', billing_hold_until: dayOffset(7), billing_hold_reason: 'POP received' });
      const res = await request(app).get('/api/fleet/portal-data').set(authHeader(owner.user));
      expect(res.status).not.toBe(402);
    });

    it('and stops keeping it open once it expires', async () => {
      await setOrg({ status: 'past_due', billing_hold_until: dayOffset(-1), billing_hold_reason: 'POP received' });
      const res = await request(app).get('/api/fleet/portal-data').set(authHeader(owner.user));
      expect(res.status, 'an expired hold was still exempting the account').toBe(402);
    });

    it('a held account is not suspended by the daily sweep', async () => {
      await setOrg({
        subscription_status: 'past_due', status: 'past_due',
        billing_grace_until: dayOffset(-1),
        billing_hold_until: dayOffset(7), billing_hold_reason: 'Payment in flight',
      });
      await dunning.suspendExpired({});
      expect((await orgRow()).status, 'a held account was suspended anyway').toBe('past_due');
    });

    it('an unheld account past its grace still is', async () => {
      await setOrg({
        subscription_status: 'past_due', status: 'past_due', billing_grace_until: dayOffset(-1),
      });
      await dunning.suspendExpired({});
      expect((await orgRow()).status).toBe('suspended');
    });
  });

  describe('chasing an EFT that has not arrived', () => {
    it('leaves them alone while the terms still run', async () => {
      await billing.runBillingRun({});
      await setOrg({ billing_grace_until: dayOffset(3) });

      await dunning.chaseEftInvoices({});
      expect((await orgRow()).subscription_status).toBe('active');
    });

    it('marks them past_due once the terms lapse, and sets a final date', async () => {
      await billing.runBillingRun({});
      await setOrg({ billing_grace_until: dayOffset(-1) });

      const chased = await dunning.chaseEftInvoices({});
      expect(chased).toEqual([org.id]);

      const after = await orgRow();
      expect(after.subscription_status).toBe('past_due');
      expect(new Date(after.billing_grace_until).getTime(),
        'the final window was not pushed out, so they would be suspended the same day')
        .toBeGreaterThan(new Date(dayOffset(0)).getTime());
    });

    it('does not chase an invoice that has been settled', async () => {
      await billing.runBillingRun({});
      await pgDb.query(`UPDATE subscription_invoices SET status = 'paid' WHERE organization_id = $1`, [org.id]);
      await setOrg({ billing_grace_until: dayOffset(-1) });

      expect(await dunning.chaseEftInvoices({})).toEqual([]);
      expect((await orgRow()).subscription_status).toBe('active');
    });

    it('does not chase a card client', async () => {
      await setOrg({ billing_method: 'card', billing_grace_until: dayOffset(-1) });
      await pgDb.query(
        `INSERT INTO subscription_invoices
           (organization_id, reference, tier, cycle, per_bike_monthly, bikes, charged_bikes,
            amount, status, period_start, period_end)
         VALUES ($1, 'REF-CARD', 'fleet', 'monthly', 100, 1, 1, 100, 'pending', $2, $3)`,
        [org.id, dayOffset(-30), dayOffset(0)]);
      expect(await dunning.chaseEftInvoices({})).toEqual([]);
    });
  });

  describe('recording the money when it arrives', () => {
    const settle = (invoiceId, body = {}) => request(app)
      .post(`/api/admin/subscription-invoices/${invoiceId}/settle`)
      .set(authHeader(superadmin.user))
      .send({ method: 'eft', reference: 'FNB-8842', ...body });

    it('marks the invoice paid and says who matched it', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();

      const res = await settle(invoice.id);
      expect(res.status).toBe(200);

      const [after] = await invoices();
      expect(after.status).toBe('paid');
      expect(after.settlement_method).toBe('eft');
      expect(after.settlement_reference).toBe('FNB-8842');
      expect(after.settled_by).toBe(superadmin.user.id);
    });

    // The point of the whole feature: a client who paid must be let back in.
    it('restores a suspended account exactly as a card payment would', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();
      await setOrg({ status: 'suspended', subscription_status: 'past_due', billing_failure_count: 3 });

      await settle(invoice.id);

      const after = await orgRow();
      expect(after.status, 'a client who paid stayed locked out').toBe('active');
      expect(after.subscription_status).toBe('active');
      expect(after.billing_failure_count).toBe(0);
      expect(after.billing_grace_until).toBeNull();
    });

    it('insists on a bank reference', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();
      const res = await settle(invoice.id, { reference: '' });
      expect(res.status, 'a payment was recorded with nothing to trace it to').toBe(400);
    });

    it('refuses to settle the same invoice twice', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();
      await settle(invoice.id);
      const res = await settle(invoice.id);
      expect(res.status).toBe(409);
    });

    it('will not record a card payment by hand', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();
      const res = await settle(invoice.id, { method: 'paystack' });
      expect(res.status, 'an invoice could be marked paid with no transaction behind it').toBe(400);
    });

    it('is on the audit trail', async () => {
      await billing.runBillingRun({});
      const [invoice] = await invoices();
      await settle(invoice.id);
      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'admin.invoice_settled'`);
      expect(rows).toHaveLength(1);
    });
  });

  describe('the admin controls', () => {
    it('sets a client to pay by EFT', async () => {
      await setOrg({ billing_method: 'card' });
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-method`)
        .set(authHeader(superadmin.user)).send({ method: 'eft' });
      expect(res.status).toBe(200);
      expect((await orgRow()).billing_method).toBe('eft');
    });

    it('refuses a method it does not know', async () => {
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-method`)
        .set(authHeader(superadmin.user)).send({ method: 'barter' });
      expect(res.status).toBe(400);
    });

    it('places a hold, with a reason', async () => {
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-hold`)
        .set(authHeader(superadmin.user))
        .send({ until: dayOffset(10), reason: 'Proof of payment received, matching it Monday' });
      expect(res.status).toBe(200);
      expect((await orgRow()).billing_hold_reason).toContain('Proof of payment');
    });

    // Whoever finds this account still running in three weeks needs to know
    // why somebody decided that was correct.
    it('will not place one without saying why', async () => {
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-hold`)
        .set(authHeader(superadmin.user)).send({ until: dayOffset(10) });
      expect(res.status).toBe(400);
    });

    it('will not place one in the past', async () => {
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-hold`)
        .set(authHeader(superadmin.user)).send({ until: dayOffset(-2), reason: 'x' });
      expect(res.status).toBe(400);
    });

    it('clears a hold', async () => {
      await setOrg({ billing_hold_until: dayOffset(5), billing_hold_reason: 'x' });
      const res = await request(app).put(`/api/admin/fleet-owners/${org.id}/billing-hold`)
        .set(authHeader(superadmin.user)).send({ until: null });
      expect(res.status).toBe(200);
      expect((await orgRow()).billing_hold_until).toBeNull();
    });

    it('lists invoices with how each was settled', async () => {
      await billing.runBillingRun({});
      const res = await request(app).get(`/api/admin/fleet-owners/${org.id}/invoices`)
        .set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
      expect(res.body.invoices).toHaveLength(1);
      expect(res.body.organization.billing_method).toBe('eft');
    });

    it.each([
      ['set the method', 'put', `billing-method`],
      ['place a hold', 'put', `billing-hold`],
    ])('an ordinary admin cannot %s', async (_l, method, path) => {
      const admin = await createPgUser({ role: 'admin' });
      const res = await request(app)[method](`/api/admin/fleet-owners/${org.id}/${path}`)
        .set(authHeader(admin.user)).send({ method: 'eft', until: dayOffset(5), reason: 'x' });
      expect(res.status).toBe(403);
    });
  });

  describe('the banking details screen', () => {
    const put = (body) => request(app).put('/api/admin/billing-settings')
      .set(authHeader(superadmin.user)).send(body);

    const full = {
      eft_account_name: 'SV Capital (Pty) Ltd', eft_bank_name: 'FNB',
      eft_account_number: '62012345678', eft_branch_code: '250655',
    };

    it('saves all four and reports them as complete', async () => {
      const res = await put(full);
      expect(res.status).toBe(200);
      expect(res.body.complete).toBe(true);

      const bank = await dunning.bankDetails();
      expect(bank.eft_account_number).toBe('62012345678');
      expect(bank.complete).toBe(true);
    });

    // An invoice naming a bank with no account number reads as a phishing
    // attempt, which is worse than the "reply for our details" fallback.
    it('refuses a half-filled set and says which field is missing', async () => {
      const res = await put({ ...full, eft_account_number: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('account number');
    });

    it('allows clearing all four together', async () => {
      await put(full);
      const res = await put({ eft_account_name: '', eft_bank_name: '', eft_account_number: '', eft_branch_code: '' });
      expect(res.status).toBe(200);
      expect(res.body.complete).toBe(false);
      expect((await dunning.bankDetails()).complete).toBe(false);
    });

    it('rejects a branch code that is not digits', async () => {
      const res = await put({ ...full, eft_branch_code: 'FNB-250655' });
      expect(res.status).toBe(400);
    });

    // Somebody who reaches an admin session and edits this quietly redirects
    // every invoice from then on. What it was matters as much as what it is.
    it('records the previous account number alongside the new one', async () => {
      await put(full);
      await put({ ...full, eft_account_number: '62099999999' });

      const { rows } = await pgDb.query(
        `SELECT metadata FROM audit_logs WHERE action = 'admin.billing_settings_update' ORDER BY id DESC LIMIT 1`);
      const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
      const change = meta.changed.find((c) => c.field === 'eft_account_number');
      expect(change, 'the account number changed and nothing recorded it').toBeTruthy();
      expect(change.from, 'the previous account number was not kept').toBe('62012345678');
      expect(change.to).toBe('62099999999');
    });

    it('says how many clients the details actually matter to', async () => {
      const res = await request(app).get('/api/admin/billing-settings').set(authHeader(superadmin.user));
      expect(res.status).toBe(200);
      // The org in beforeEach is on EFT.
      expect(res.body.eft_organizations).toBe(1);
    });

    it('says who changed them last', async () => {
      await put(full);
      const res = await request(app).get('/api/admin/billing-settings').set(authHeader(superadmin.user));
      expect(res.body.last_changed.by).toBe(superadmin.user.full_name);
    });

    it.each([['read', 'get'], ['change', 'put']])('an ordinary admin cannot %s them', async (_l, method) => {
      const admin = await createPgUser({ role: 'admin' });
      const res = await request(app)[method]('/api/admin/billing-settings')
        .set(authHeader(admin.user)).send(full);
      expect(res.status).toBe(403);
    });
  });

  describe('the invoice email', () => {
    it('carries the bank details and the reference to pay under', async () => {
      for (const [k, v] of Object.entries({
        eft_bank_name: 'FNB', eft_account_name: 'SV Capital (Pty) Ltd',
        eft_account_number: '62012345678', eft_branch_code: '250655',
      })) {
        await pgDb.query(
          `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES ($1,$2,NOW())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`, [k, v]);
      }
      const bank = await dunning.bankDetails();
      expect(bank.complete).toBe(true);

      const body = dunning.eftInvoiceBody({
        org: { name: 'Kasi Couriers' },
        invoice: { amount: 4312.5, description: 'October', reference: 'PIL-abc123' },
        dueBy: dayOffset(14),
        bank,
      });
      expect(body).toContain('62012345678');
      expect(body).toContain('PIL-abc123');
    });

    // An invoice with a blank account number reads as a phishing attempt.
    it('says to ask rather than printing a blank account number', async () => {
      const bank = await dunning.bankDetails();
      expect(bank.complete).toBe(false);
      const body = dunning.eftInvoiceBody({
        org: { name: 'Kasi Couriers' },
        invoice: { amount: 100, reference: 'PIL-x' },
        dueBy: dayOffset(14),
        bank,
      });
      expect(body).toContain('Reply to this email');
      expect(body).not.toContain('Account number:');
    });
  });
});
