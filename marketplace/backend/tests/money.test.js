import { describe, it, expect } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const promos = require('../src/promos');

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  const rider = t.api(await t.login('rider1@clicknpuff.africa'));
  await admin.put('/api/admin/settings', { deliveryOpenHour: 0, deliveryCloseHour: 24 });
  await rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const p = store.products.find((x) => x.stock >= 10 && !/flower|pre-rolls|extracts/.test(x.category.slug));
  const order = async (extra = {}) => {
    const res = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(20000 / p.priceCents) }], ...DROP, ...extra });
    if (res.status !== 201) return res;
    return (await customer.post(`/api/orders/${res.body.order.id}/pay`)).body.order;
  };
  const deliver = async (extra) => {
    const o = await order(extra);
    if (!o.id) return o;
    await merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    await rider.post(`/api/rider/offers/${o.id}/accept`);
    await merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready', sealed: true });
    await rider.post(`/api/rider/jobs/${o.id}/pickup`, { bagCode: o.code.slice(-4) });
    const d = await rider.post(`/api/rider/jobs/${o.id}/deliver`, { handoverCode: o.handoverCode, idChecked: true });
    expect(d.status).toBe(200);
    return o;
  };
  const row = (id) => t.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return { ...t, customer, merchant, admin, rider, store, order, deliver, row };
}

describe('bank and tax details', () => {
  it('needs the password to change the bank account, masks it for the store and flags the change to admin', async () => {
    const w = await world();
    const bank = { bankName: 'FNB', accountHolder: 'Rosebank Botanicals (Pty) Ltd', accountNumber: '6200 1234 567', accountType: 'cheque' };
    expect((await w.merchant.put('/api/merchant/bank', { ...bank, password: 'wrong-one' })).status).toBe(400);
    expect((await w.merchant.put('/api/merchant/bank', { ...bank, accountNumber: '12', password: 'password123' })).status).toBe(400);
    const ok = await w.merchant.put('/api/merchant/bank', { ...bank, password: 'password123' });
    expect(ok.body.bank).toMatchObject({ bankName: 'FNB', branchCode: '250655', accountNumber: '••••4567' });
    const adm = (await w.admin.get('/api/admin/payouts')).body.stores.find((s) => s.name === 'Rosebank Botanicals');
    expect(adm.bank.accountNumber).toBe('62001234567');
    expect(adm.bankChangedRecently).toBe(true);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'bank_details_changed'").get().n).toBe(1);

    expect((await w.merchant.put('/api/merchant/tax', { vatNumber: '123' })).status).toBe(400);
    expect((await w.merchant.put('/api/merchant/tax', { legalName: 'RB Trading (Pty) Ltd', vatNumber: '4123456789' })).body.tax).toMatchObject({ vatNumber: '4123456789' });
  });
});

describe('store promo codes', () => {
  it('only work at their store, come off the store payout and not the platform', async () => {
    const w = await world();
    expect((await w.merchant.post('/api/merchant/promos', { code: 'WELCOME20', kind: 'percent', value: 10 })).status).toBe(409);
    expect((await w.merchant.post('/api/merchant/promos', { code: 'BIG', kind: 'percent', value: 10 })).status).toBe(400);
    expect((await w.merchant.post('/api/merchant/promos', { code: 'HALFOFF', kind: 'percent', value: 60 })).status).toBe(400);
    const made = await w.merchant.post('/api/merchant/promos', { code: 'rose50', kind: 'fixed', value: 5000, minSubtotalCents: 15000 });
    expect(made.status).toBe(201);
    expect(made.body.promo).toMatchObject({ code: 'ROSE50', description: 'R50 off orders over R150' });
    expect((await request(w.app).get('/api/stores/rosebank-botanicals')).body.promos.map((p) => p.code)).toContain('ROSE50');

    // Other stores' customers can't use it.
    const otherId = w.db.prepare('SELECT id FROM stores WHERE id <> ? LIMIT 1').get(w.store.store.id).id;
    const custId = w.db.prepare("SELECT id FROM users WHERE email = 'customer@clicknpuff.africa'").get().id;
    expect(promos.apply(w.db, 'ROSE50', { userId: custId, storeId: otherId, subtotalCents: 30000, deliveryFeeCents: 2500 }).reason).toMatch(/only works at Rosebank Botanicals/);

    const o = await w.deliver({ promoCode: 'ROSE50' });
    const r = w.row(o.id);
    expect(r).toMatchObject({ discount_cents: 5000, store_discount_cents: 5000 });
    const pay = (await w.merchant.get('/api/merchant/payouts')).body;
    expect(pay.balanceCents).toBe(r.subtotal_cents - 5000);
    const d = (await w.admin.get('/api/admin/dashboard')).body.today;
    expect(d.netRevenueCents).toBe(r.service_fee_cents + r.delivery_fee_cents - r.rider_payout_cents); // the store paid for it
    const list = (await w.merchant.get('/api/merchant/promos')).body.promos;
    expect(list[0]).toMatchObject({ code: 'ROSE50', uses: 1, discountGivenCents: 5000 });
    await w.merchant.patch('/api/merchant/promos/ROSE50', { active: false });
    expect((await request(w.app).get('/api/stores/rosebank-botanicals')).body.promos).toEqual([]);
  });
});

describe('payouts, refunds and statements', () => {
  it('records payouts against the balance, splits refunds, and produces a statement', async () => {
    const w = await world();
    const a = await w.deliver();
    const b = await w.deliver();
    const earned = w.row(a.id).subtotal_cents + w.row(b.id).subtotal_cents;
    const storeId = w.store.store.id;
    expect((await w.merchant.get('/api/merchant/payouts')).body.balanceCents).toBe(earned);

    // Refund part of order b: the store carries it.
    expect((await w.admin.post(`/api/admin/orders/${b.id}/refund`, { amountCents: 3000, reason: 'Damaged', borneBy: 'nobody' })).status).toBe(400);
    expect((await w.admin.post(`/api/admin/orders/${b.id}/refund`, { amountCents: 999999, reason: 'Too much', borneBy: 'store' })).status).toBe(400);
    const r1 = await w.admin.post(`/api/admin/orders/${b.id}/refund`, { amountCents: 3000, reason: 'Grinder arrived cracked', borneBy: 'store' });
    expect(r1.body).toMatchObject({ storeCents: 3000, platformCents: 0 });
    // And a goodwill refund the platform carries.
    const before = (await w.admin.get('/api/admin/dashboard')).body.today.netRevenueCents;
    await w.admin.post(`/api/admin/orders/${a.id}/refund`, { amountCents: 1500, reason: 'Late delivery', borneBy: 'platform' });
    expect((await w.admin.get('/api/admin/dashboard')).body.today.netRevenueCents).toBe(before - 1500);
    expect(w.row(b.id)).toMatchObject({ refund_cents: 3000, store_refund_cents: 3000 });
    expect((await w.customer.get(`/api/orders/${b.id}`)).body.order.totals.refundedCents).toBe(3000);

    const owed = earned - 3000;
    const adminView = (await w.admin.get('/api/admin/payouts')).body.stores.find((s) => s.storeId === storeId);
    expect(adminView.balanceCents).toBe(owed);
    expect((await w.admin.post('/api/admin/payouts', { storeId, amountCents: owed + 100, reference: 'X' })).status).toBe(409);
    expect((await w.admin.post('/api/admin/payouts', { storeId, amountCents: 1000 })).status).toBe(400);
    const paid = await w.admin.post('/api/admin/payouts', { storeId, amountCents: owed - 2000, reference: 'FNB 88231' });
    expect(paid.body.balanceCents).toBe(2000);
    const mine = (await w.merchant.get('/api/merchant/payouts')).body;
    expect(mine.payouts[0]).toMatchObject({ amountCents: owed - 2000, reference: 'FNB 88231' });
    expect(mine.balanceCents).toBe(2000);
    const batch = await w.admin.get('/api/admin/payouts/batch.csv');
    expect(batch.text).toContain('Rosebank Botanicals');
    expect(batch.text).toContain('20.00');
    expect(batch.text).toContain('No bank details');

    const st = (await w.merchant.get('/api/merchant/statement')).body;
    expect(st).toMatchObject({ openingBalanceCents: 0, earnedCents: owed, paidCents: owed - 2000, closingBalanceCents: 2000, storeRefundCents: 3000 });
    expect(st.orders).toHaveLength(2);
    const sheet = await w.merchant.get('/api/merchant/statement?format=csv');
    expect(sheet.headers['content-type']).toMatch(/text\/csv/);
    expect(sheet.text).toContain('FNB 88231');
    expect(sheet.text).toContain('closing_balance');
    // A later window opens with what was left.
    const tomorrow = new Date(Date.now() + 2 * 3600e3 + 86400e3).toISOString().slice(0, 10);
    expect((await w.merchant.get(`/api/merchant/statement?from=${tomorrow}&to=${tomorrow}`)).body).toMatchObject({ openingBalanceCents: 2000, orders: [] });
    // Active orders aren't refunded here.
    const live = await w.order();
    expect((await w.admin.post(`/api/admin/orders/${live.id}/refund`, { amountCents: 100, reason: 'x', borneBy: 'platform' })).status).toBe(409);
  });
});

describe('tax invoices', () => {
  it('splits the goods (from the store) and the fees (from the platform), with VAT only for VAT vendors', async () => {
    const w = await world();
    await w.merchant.put('/api/merchant/tax', { legalName: 'RB Trading (Pty) Ltd', vatNumber: '4123456789' });
    const o = await w.deliver({ tipCents: 2000 });
    const r = w.row(o.id);
    const inv = (await w.customer.get(`/api/orders/${o.id}/invoice`)).body;
    expect(inv.number).toBe(`INV-${o.code}`);
    expect(inv.goods).toMatchObject({ taxInvoice: true, totalCents: r.subtotal_cents, vatCents: Math.round((r.subtotal_cents * 15) / 115) });
    expect(inv.goods.supplier).toMatchObject({ name: 'RB Trading (Pty) Ltd', tradingAs: 'Rosebank Botanicals', vatNumber: '4123456789' });
    expect(inv.services).toMatchObject({ taxInvoice: false, vatCents: null, totalCents: r.delivery_fee_cents + r.service_fee_cents });
    expect(inv.goods.totalCents + inv.services.totalCents + inv.tipCents).toBe(inv.paidCents);

    await w.admin.put('/api/admin/company', { vatNumber: '4999999999', address: '1 Main Rd, Johannesburg' });
    expect((await w.customer.get(`/api/orders/${o.id}/invoice`)).body.services).toMatchObject({ taxInvoice: true, supplier: { vatNumber: '4999999999' } });
    expect((await w.admin.put('/api/admin/company', { vatNumber: '12' })).status).toBe(400);

    const someoneElse = w.api(await w.login('merchant2@clicknpuff.africa'));
    expect((await someoneElse.get(`/api/orders/${o.id}/invoice`)).status).toBe(404);
    const live = await w.order();
    expect((await w.customer.get(`/api/orders/${live.id}/invoice`)).status).toBe(409);
  });

  it('puts a platform promo against the platform fees first', async () => {
    const w = await world();
    const o = await w.deliver({ promoCode: 'WELCOME20' });
    const r = w.row(o.id);
    expect(r.discount_cents).toBeGreaterThan(0);
    const inv = (await w.customer.get(`/api/orders/${o.id}/invoice`)).body;
    const fees = r.delivery_fee_cents + r.service_fee_cents;
    expect(inv.services.discountCents).toBe(Math.min(r.discount_cents, fees));
    expect(inv.goods.totalCents + inv.services.totalCents).toBe(r.total_cents - r.tip_cents);
  });
});
