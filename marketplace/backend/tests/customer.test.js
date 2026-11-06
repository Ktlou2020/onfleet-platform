import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const token = await t.login('customer@cloud9.africa');
  const customer = t.api(token);
  const admin = t.api(await t.login('admin@cloud9.africa'));
  const merchant = t.api(await t.login('merchant1@cloud9.africa'));
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const p = store.products.find((x) => x.stock >= 10 && x.priceCents >= 20000) || store.products.find((x) => x.stock >= 10);
  const basket = (rand) => ({ storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(rand / p.priceCents) }], ...DROP });
  const place = async (body) => {
    const r = await customer.post('/api/orders', body);
    if (r.status !== 201) return r;
    return (await customer.post(`/api/orders/${r.body.order.id}/pay`)).body.order;
  };
  return { ...t, token, customer, admin, merchant, store, p, basket, place };
}

describe('promo codes', () => {
  it('quotes a first-order discount and charges it', async () => {
    const w = await world();
    const plain = (await w.customer.post('/api/quote', w.basket(40000))).body.quote;
    const q = (await w.customer.post('/api/quote', { ...w.basket(40000), promoCode: 'welcome20' })).body.quote;
    expect(q.promo.code).toBe('WELCOME20');
    expect(q.discountCents).toBe(Math.min(Math.round(plain.subtotalCents * 0.2), 6000));
    expect(q.totalCents).toBe(plain.totalCents - q.discountCents);
    expect(q.vatCents).toBe(Math.round((q.totalCents * 0.15) / 1.15));

    const order = await w.place({ ...w.basket(40000), promoCode: 'WELCOME20', tipCents: 1000 });
    expect(order.totals).toMatchObject({ discountCents: q.discountCents, promoCode: 'WELCOME20', totalCents: q.totalCents + 1000 });
    // First order only, and only once.
    const again = (await w.customer.post('/api/quote', { ...w.basket(40000), promoCode: 'WELCOME20' })).body.quote;
    expect(again.promoError).toMatch(/first order|already used/);
    expect((await w.customer.post('/api/orders', { ...w.basket(40000), promoCode: 'WELCOME20' })).status).toBe(400);
  });

  it('gives back a code when the order is cancelled', async () => {
    const w = await world();
    const o = await w.place({ ...w.basket(40000), promoCode: 'WELCOME20' });
    await w.customer.post(`/api/orders/${o.id}/cancel`, { reason: 'Changed my mind' });
    expect((await w.customer.post('/api/quote', { ...w.basket(40000), promoCode: 'WELCOME20' })).body.quote.promo).toBeTruthy();
  });

  it('explains why a code does not apply', async () => {
    const w = await world();
    const q = (code, rand = 40000) => w.customer.post('/api/quote', { ...w.basket(rand), promoCode: code }).then((r) => r.body.quote);
    expect((await q('NOPE')).promoError).toBe("That code isn't valid");
    w.db.prepare("UPDATE promos SET min_subtotal_cents = 99999900 WHERE code = 'WELCOME20'").run();
    expect((await q('WELCOME20')).promoError).toMatch(/Spend R999999/);
    w.db.prepare("UPDATE promos SET min_subtotal_cents = 10000 WHERE code = 'WELCOME20'").run();
    expect((await request(w.app).post('/api/quote').send({ ...w.basket(40000), promoCode: 'WELCOME20' })).body.quote.promoError).toMatch(/Sign in/);
    // Free delivery when delivery is already free (over R600) has nothing to give.
    expect((await q('FREEDEL', 70000)).promoError).toMatch(/already free/);
    w.db.prepare("UPDATE promos SET expires_at = '2020-01-01T00:00:00Z' WHERE code = 'FREEDEL'").run();
    expect((await q('FREEDEL')).promoError).toBe('That code has expired');
  });

  it('suggests only codes the customer can still use', async () => {
    const w = await world();
    expect((await w.customer.get('/api/promos')).body.promos.map((p) => p.code)).toEqual(expect.arrayContaining(['WELCOME20', 'FREEDEL']));
    const o = await w.place({ ...w.basket(40000), promoCode: 'WELCOME20' });
    expect(o.status).toBe('placed');
    expect((await w.customer.get('/api/promos')).body.promos.map((p) => p.code)).not.toContain('WELCOME20');
  });

  it('takes funded discounts out of net revenue', async () => {
    const w = await world();
    const o = await w.place({ ...w.basket(40000), promoCode: 'WELCOME20' });
    const rider = w.api(await w.login('rider1@cloud9.africa'));
    await rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    await rider.post(`/api/rider/offers/${o.id}/accept`);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    await rider.post(`/api/rider/jobs/${o.id}/pickup`);
    await rider.post(`/api/rider/jobs/${o.id}/deliver`, { handoverCode: o.handoverCode, idChecked: true });
    const row = w.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    const d = (await w.admin.get('/api/admin/dashboard')).body.today;
    expect(d.discountsCents).toBe(row.discount_cents);
    expect(d.netRevenueCents).toBe(row.service_fee_cents + row.delivery_fee_cents - row.rider_payout_cents - row.discount_cents);
    // The store is still owed its full item total.
    expect((await w.merchant.get('/api/merchant/payouts')).body.statements[0].payoutCents).toBe(row.subtotal_cents);
  });
});

describe('addresses, favourites, ordering again', () => {
  it('saves, edits and deletes addresses, privately', async () => {
    const w = await world();
    expect((await w.customer.post('/api/me/addresses', { label: 'Home', address: 'x', lat: 0, lng: 0 })).status).toBe(400);
    const home = (await w.customer.post('/api/me/addresses', { label: 'Home', ...DROP, notes: 'Gate 4' })).body.address;
    await w.customer.patch(`/api/me/addresses/${home.id}`, { label: 'Home 🏠' });
    expect((await w.customer.get('/api/me/addresses')).body.addresses).toEqual([expect.objectContaining({ label: 'Home 🏠', notes: 'Gate 4' })]);
    const reg = await request(w.app).post('/api/auth/register').send({ email: 'other@x.co.za', password: 'longenough', name: 'Other' });
    const other = w.api(reg.body.token);
    expect((await other.get('/api/me/addresses')).body.addresses).toHaveLength(0);
    expect((await other.delete(`/api/me/addresses/${home.id}`)).status).toBe(404);
    expect((await w.customer.delete(`/api/me/addresses/${home.id}`)).status).toBe(200);
  });

  it('keeps favourite stores', async () => {
    const w = await world();
    await w.customer.put(`/api/me/favourites/${w.store.store.id}`);
    await w.customer.put(`/api/me/favourites/${w.store.store.id}`); // twice is fine
    expect((await w.customer.get('/api/me/favourites')).body.stores.map((s) => s.slug)).toEqual(['rosebank-botanicals']);
    await w.customer.delete(`/api/me/favourites/${w.store.store.id}`);
    expect((await w.customer.get('/api/me/favourites')).body.stores).toHaveLength(0);
    expect((await w.customer.put('/api/me/favourites/9999')).status).toBe(404);
  });

  it('rebuilds a basket from a past order and flags what is gone', async () => {
    const w = await world();
    const second = w.store.products.find((x) => x.id !== w.p.id && x.stock >= 2);
    const o = await w.place({ storeId: w.store.store.id, items: [{ productId: w.p.id, qty: Math.ceil(12000 / w.p.priceCents) }, { productId: second.id, qty: 2 }], ...DROP });
    w.db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(second.id);
    const r = (await w.customer.get(`/api/orders/${o.id}/reorder`)).body;
    expect(r.store.slug).toBe('rosebank-botanicals');
    expect(r.items.find((i) => i.productId === w.p.id)).toMatchObject({ available: true, priceCents: w.p.priceCents });
    expect(r.items.find((i) => i.productId === second.id)).toMatchObject({ available: false, reason: 'Sold out' });
  });
});

describe('help with an order', () => {
  it('lets a customer report a problem once, and admin resolve it', async () => {
    const w = await world();
    const o = await w.place(w.basket(15000));
    expect((await w.customer.post(`/api/orders/${o.id}/help`, { type: 'nonsense' })).status).toBe(400);
    const r = (await w.customer.post(`/api/orders/${o.id}/help`, { type: 'missing_item', note: 'No papers in the bag' })).body.request;
    expect(r).toMatchObject({ status: 'open', typeLabel: 'Something was missing' });
    expect((await w.customer.post(`/api/orders/${o.id}/help`, { type: 'late' })).status).toBe(409);
    expect((await w.admin.get('/api/admin/overview')).body.openIncidents).toBeGreaterThanOrEqual(1);
    expect((await w.admin.get('/api/admin/dashboard')).body.actions.map((a) => a.type)).toContain('help');

    const list = (await w.admin.get('/api/admin/help')).body.requests;
    expect(list[0]).toMatchObject({ orderCode: o.code, customer: { email: 'customer@cloud9.africa' } });
    expect((await w.admin.post(`/api/admin/help/${r.id}/resolve`, {})).status).toBe(400);
    await w.admin.post(`/api/admin/help/${r.id}/resolve`, { resolution: 'Refunded R35 for the papers' });
    expect((await w.customer.get(`/api/orders/${o.id}/help`)).body.requests[0]).toMatchObject({ status: 'resolved', resolution: 'Refunded R35 for the papers' });
  });
});
