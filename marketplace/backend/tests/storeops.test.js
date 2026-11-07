import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const { merchantSweep } = require('../src/merchant');
const sms = require('../src/sms');

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };
const flush = () => new Promise((r) => setImmediate(r));

async function world() {
  const t = await setup();
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const rider = t.api(await t.login('rider1@clicknpuff.africa'));
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const [a, b] = store.products.filter((x) => x.stock >= 10);
  // Two lines: a cheap one and one big enough to keep the order over the minimum.
  const place = async (lines = [{ productId: a.id, qty: 1 }, { productId: b.id, qty: Math.ceil(12000 / b.priceCents) }]) => {
    const c = await customer.post('/api/orders', { storeId: store.store.id, items: lines, ...DROP });
    return (await customer.post(`/api/orders/${c.body.order.id}/pay`)).body.order;
  };
  const stock = (id) => t.db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
  return { ...t, customer, merchant, rider, admin, store, a, b, place, stock };
}

describe('sold-out items on an order', () => {
  it('lets the customer go ahead without them, refunding just those items', async () => {
    const w = await world();
    const o = await w.place();
    const line = o.items.find((i) => i.product_id === w.a.id);
    const r = (await w.merchant.post(`/api/merchant/orders/${o.id}/unavailable`, { productIds: [w.a.id] })).body.order;
    expect(r.awaitingCustomer).toBe('item_unavailable');
    expect(w.stock(w.a.id)).toBe(0); // marked sold out on the menu too
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 })).status).toBe(409);

    const after = (await w.customer.post(`/api/orders/${o.id}/item-decision`, { decision: 'continue' })).body.order;
    const removed = line.price_cents * line.qty;
    expect(after.totals).toMatchObject({ subtotalCents: o.totals.subtotalCents - removed, totalCents: o.totals.totalCents - removed, refundedCents: removed });
    expect(after.items.find((i) => i.product_id === w.a.id).unavailable).toBe(true);
    expect(after.awaitingCustomer).toBeNull();
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 })).status).toBe(200);
  });

  it('cancels for a full refund, and keeps the sold-out item at zero stock', async () => {
    const w = await world();
    const o = await w.place();
    const bBefore = w.stock(w.b.id);
    await w.merchant.post(`/api/merchant/orders/${o.id}/unavailable`, { productIds: [w.a.id] });
    const r = (await w.customer.post(`/api/orders/${o.id}/item-decision`, { decision: 'cancel' })).body.order;
    expect(r).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    expect(w.stock(w.a.id)).toBe(0);
    expect(w.stock(w.b.id)).toBe(bBefore + o.items.find((i) => i.product_id === w.b.id).qty);
  });

  it('declines outright when everything is gone, and continues by itself if the customer goes quiet', async () => {
    const w = await world();
    const all = await w.place();
    const d = (await w.merchant.post(`/api/merchant/orders/${all.id}/unavailable`, { productIds: [w.a.id, w.b.id] })).body;
    expect(d.declined).toBe(true);
    expect((await w.customer.get(`/api/orders/${all.id}`)).body.order).toMatchObject({ status: 'rejected', paymentStatus: 'refunded' });

    w.db.prepare('UPDATE products SET stock = 20 WHERE id IN (?, ?)').run(w.a.id, w.b.id);
    const o = await w.place();
    await w.merchant.post(`/api/merchant/orders/${o.id}/unavailable`, { productIds: [w.a.id] });
    expect(merchantSweep(w.db, null, new Date(Date.now() + 4 * 60000)).continued).toBe(0);
    expect(merchantSweep(w.db, null, new Date(Date.now() + 6 * 60000)).continued).toBe(1);
    const seen = (await w.customer.get(`/api/orders/${o.id}`)).body.order;
    expect(seen.awaitingCustomer).toBeNull();
    expect(seen.events.map((e) => e.status)).toContain('items_removed');
  });
});

describe('never miss an order', () => {
  it('accepts automatically for stores that opt in', async () => {
    const w = await world();
    await w.merchant.patch('/api/merchant/store', { autoAccept: true });
    const o = await w.place();
    await flush();
    const seen = (await w.customer.get(`/api/orders/${o.id}`)).body.order;
    expect(seen.status).toBe('accepted');
    expect(seen.events.find((e) => e.status === 'accepted').note).toBe('Accepted automatically');
  });

  it('nudges the store after 3 minutes and declines with a refund at 10', async () => {
    const w = await world();
    const o = await w.place();
    w.db.prepare("UPDATE orders SET updated_at = datetime('now', '-4 minutes') WHERE id = ?").run(o.id);
    expect(merchantSweep(w.db, null)).toMatchObject({ escalated: 1, declined: 0 });
    expect(merchantSweep(w.db, null)).toMatchObject({ escalated: 0 }); // only once
    w.db.prepare("UPDATE orders SET updated_at = datetime('now', '-11 minutes') WHERE id = ?").run(o.id);
    expect(merchantSweep(w.db, null).declined).toBe(1);
    expect((await w.customer.get(`/api/orders/${o.id}`)).body.order).toMatchObject({ status: 'rejected', paymentStatus: 'refunded', cancelReason: expect.stringMatching(/didn't respond/) });
  });

  it('formats South African numbers for SMS and stays off without a provider', async () => {
    expect(sms.toInternational('082 123 4567')).toBe('+27821234567');
    expect(sms.toInternational('+27 82 123 4567')).toBe('+27821234567');
    expect(sms.toInternational('12345')).toBeNull();
    expect(await sms.send('0821234567', 'hi', vi.fn())).toBe(false);
  });
});

describe('at the counter', () => {
  it('shows how far off the rider is, and makes the rider match the bag', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.16, lng: 28.06 });
    const o = await w.place();
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    await w.rider.post(`/api/rider/offers/${o.id}/accept`);
    const card = (await w.merchant.get('/api/merchant/orders')).body.live.find((x) => x.id === o.id);
    expect(card.riderEtaMinutes).toBeGreaterThan(1);

    const job = (await w.rider.get('/api/rider/jobs')).body.current[0];
    expect(job.code).toBe(`${o.code.slice(0, -4)}••••`);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    expect((await w.rider.post(`/api/rider/jobs/${o.id}/pickup`)).status).toBe(400);
    expect((await w.rider.post(`/api/rider/jobs/${o.id}/pickup`, { bagCode: 'ZZZZ' })).body.error).toMatch(/not this order's bag/);
    expect((await w.rider.post(`/api/rider/jobs/${o.id}/pickup`, { bagCode: o.code.slice(-4).toLowerCase() })).status).toBe(200);
  });

  it('needs a sealed, labelled bag for regulated items', async () => {
    const w = await world();
    await w.admin.put('/api/admin/settings', { regulatedSalesEnabled: true });
    await w.admin.post(`/api/admin/stores/${w.store.store.id}`, { licenceVerified: true, licenceCategories: ['flower'] });
    const flower = (await request(w.app).get('/api/stores/rosebank-botanicals')).body.products.find((p) => p.category.slug === 'flower' && p.stock >= 2);
    const o = await w.place([{ productId: flower.id, qty: 1 }, { productId: w.b.id, qty: Math.ceil(12000 / w.b.priceCents) }]);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    expect((await w.merchant.get('/api/merchant/orders')).body.live[0].regulated).toBe(true);
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' })).status).toBe(400);
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready', sealed: true })).body.order.sealed).toBe(true);
  });
});
