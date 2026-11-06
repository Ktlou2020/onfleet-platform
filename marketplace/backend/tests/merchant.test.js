import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const { availability } = require('../src/storeHours');

// Thursday 5 Nov 2026, 12:00 SAST.
const NOW = new Date('2026-11-05T10:00:00Z');
beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const customer = t.api(await t.login('customer@cloud9.africa'));
  const merchant = t.api(await t.login('merchant1@cloud9.africa'));
  const admin = t.api(await t.login('admin@cloud9.africa'));
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const place = async () => {
    const p = store.products.find((x) => x.stock >= 10);
    const res = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(10000 / p.priceCents) }], ...DROP });
    if (res.status !== 201) return res;
    return (await customer.post(`/api/orders/${res.body.order.id}/pay`)).body.order;
  };
  return { ...t, customer, merchant, admin, store, place };
}

describe('opening hours and pauses', () => {
  it('works out open, paused and closed-by-hours', () => {
    const base = { is_open: 1, paused_until: null, hours: null };
    expect(availability(base, NOW)).toMatchObject({ open: true });
    expect(availability({ ...base, is_open: 0 }, NOW)).toMatchObject({ open: false, reason: 'closed' });
    expect(availability({ ...base, paused_until: new Date(NOW.getTime() + 30 * 60000).toISOString() }, NOW)).toMatchObject({ open: false, reason: 'paused', label: 'Busy — back at 12:30' });
    const hours = JSON.stringify({ thu: ['14:00', '20:00'], fri: ['09:00', '17:00'] });
    expect(availability({ ...base, hours }, NOW)).toMatchObject({ open: false, label: 'Opens today at 14:00' });
    const late = new Date('2026-11-05T19:00:00Z'); // 21:00 SAST Thursday
    expect(availability({ ...base, hours }, late)).toMatchObject({ open: false, label: 'Opens tomorrow at 09:00' });
    expect(availability({ ...base, hours }, new Date('2026-11-05T13:00:00Z'))).toMatchObject({ open: true, closesAt: '20:00' });
  });

  it('pausing stops orders and tells customers when the store is back', async () => {
    const w = await world();
    const paused = (await w.merchant.patch('/api/merchant/store', { pauseMinutes: 30 })).body.store;
    expect(paused.availability).toMatchObject({ open: false, reason: 'paused' });
    const pub = (await request(w.app).get('/api/stores/rosebank-botanicals')).body.store;
    expect(pub).toMatchObject({ isOpen: false, openLabel: 'Busy — back at 12:30' });
    const blocked = await w.place();
    expect(blocked.status).toBe(409);
    expect((await w.merchant.patch('/api/merchant/store', { pauseMinutes: 0 })).body.store.availability.open).toBe(true);
    expect((await w.merchant.patch('/api/merchant/store', { pauseMinutes: 7 })).status).toBe(400);
  });

  it('saves weekly hours and rejects nonsense', async () => {
    const w = await world();
    expect((await w.merchant.patch('/api/merchant/store', { hours: { mon: ['18:00', '09:00'] } })).status).toBe(400);
    expect((await w.merchant.patch('/api/merchant/store', { hours: { mon: ['9am', '5pm'] } })).status).toBe(400);
    const s = (await w.merchant.patch('/api/merchant/store', { hours: { thu: ['14:00', '20:00'] } })).body.store;
    expect(s.hours).toMatchObject({ thu: ['14:00', '20:00'], mon: null });
    expect(s.availability.label).toBe('Opens today at 14:00');
  });

  it('busy mode adds prep time to the ETA customers see', async () => {
    const w = await world();
    const before = (await request(w.app).get('/api/stores/rosebank-botanicals').query(DROP)).body.store.etaMinutes;
    await w.merchant.patch('/api/merchant/store', { busyExtraMinutes: 20 });
    const after = (await request(w.app).get('/api/stores/rosebank-botanicals').query(DROP)).body.store.etaMinutes;
    expect(after - before).toBe(20);
  });
});

describe('the order board', () => {
  it('moves an order through the lanes and resets the ETA to the prep promise', async () => {
    const w = await world();
    const o = await w.place();
    let board = (await w.merchant.get('/api/merchant/orders')).body;
    expect(board.live[0]).toMatchObject({ id: o.id, lane: 'new' });

    const accepted = (await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 20 })).body.order;
    expect(accepted).toMatchObject({ lane: 'preparing', prepMinutes: 20 });
    expect(accepted.prepSecondsLeft).toBeGreaterThan(19 * 60);
    expect(accepted.etaMinutes).toBeGreaterThanOrEqual(20 + 4);
    expect((await w.customer.get(`/api/orders/${o.id}`)).body.order.etaMinutes).toBe(accepted.etaMinutes);

    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    board = (await w.merchant.get('/api/merchant/orders')).body;
    expect(board.live[0]).toMatchObject({ lane: 'ready', readyAt: expect.any(String) });
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 })).status).toBe(409); // already ready
  });

  it('needs a reason to decline, and shows it to the customer', async () => {
    const w = await world();
    const o = await w.place();
    expect((await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'rejected' })).status).toBe(400);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'rejected', reasonCode: 'out_of_stock', reason: 'Grinders sold out' });
    const seen = (await w.customer.get(`/api/orders/${o.id}`)).body.order;
    expect(seen).toMatchObject({ status: 'rejected', paymentStatus: 'refunded', cancelReason: 'An item is out of stock — Grinders sold out' });
    expect((await w.merchant.get('/api/merchant/orders')).body.recent[0]).toMatchObject({ id: o.id, lane: 'done' });
  });

  it('flags low stock and keeps sold-out items off the shelf', async () => {
    const w = await world();
    const p = w.store.products[0];
    await w.merchant.patch(`/api/merchant/products/${p.id}`, { stock: 2 });
    expect((await w.merchant.get('/api/merchant/orders')).body.lowStock.map((x) => x.id)).toContain(p.id);
    await w.merchant.patch(`/api/merchant/products/${p.id}`, { stock: 0 });
    const mine = (await w.merchant.get('/api/merchant/products')).body.products.find((x) => x.id === p.id);
    expect(mine).toMatchObject({ live: false, inStock: false });
  });
});

describe('insights, payouts and reviews', () => {
  async function deliver(w) {
    const rider = w.api(await w.login('rider1@cloud9.africa'));
    await rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const o = await w.place();
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    await rider.post(`/api/rider/offers/${o.id}/accept`);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    await rider.post(`/api/rider/jobs/${o.id}/pickup`);
    await rider.post(`/api/rider/jobs/${o.id}/deliver`, { handoverCode: o.handoverCode, idChecked: true });
    return o;
  }

  it('reports sales, acceptance and best sellers, and owes the item total', async () => {
    const w = await world();
    const o = await deliver(w);
    const declined = await w.place();
    await w.merchant.post(`/api/merchant/orders/${declined.id}/status`, { status: 'rejected', reasonCode: 'too_busy' });

    const ins = (await w.merchant.get('/api/merchant/insights?days=7')).body;
    expect(ins.totals).toMatchObject({ orders: 1, salesCents: o.totals.subtotalCents, avgOrderCents: o.totals.subtotalCents, acceptanceRate: 50 });
    expect(ins.series).toHaveLength(7);
    expect(ins.topProducts[0]).toMatchObject({ name: o.items[0].name, qty: o.items[0].qty });
    expect((await w.merchant.get('/api/merchant/insights?days=30')).body.series).toHaveLength(30);

    const pay = (await w.merchant.get('/api/merchant/payouts')).body;
    expect(pay.statements[0]).toMatchObject({ orders: 1, payoutCents: o.totals.subtotalCents, refundedOrders: 1, status: 'in_progress' });
  });

  it('lets the store reply to a review, shown on its public page', async () => {
    const w = await world();
    const o = await deliver(w);
    await w.customer.post(`/api/orders/${o.id}/review`, { rating: 4, comment: 'Quick, thanks' });
    const r = (await w.merchant.get('/api/merchant/reviews')).body;
    expect(r.distribution.find((x) => x.stars === 4).count).toBe(1);
    expect((await w.merchant.post(`/api/merchant/reviews/${r.reviews[0].id}/reply`, { reply: '' })).status).toBe(400);
    await w.merchant.post(`/api/merchant/reviews/${r.reviews[0].id}/reply`, { reply: 'Thank you, see you soon!' });
    const pub = (await request(w.app).get('/api/stores/rosebank-botanicals')).body.reviews;
    expect(pub[0]).toMatchObject({ comment: 'Quick, thanks', reply: 'Thank you, see you soon!' });
    // Another store can't reply to it.
    const other = w.api(await w.login('merchant2@cloud9.africa'));
    expect((await other.post(`/api/merchant/reviews/${r.reviews[0].id}/reply`, { reply: 'hi' })).status).toBe(404);
  });

  it('still lists stores for admin', async () => {
    const w = await world();
    const stores = (await w.admin.get('/api/admin/stores')).body.stores;
    expect(stores.find((s) => s.name === 'Rosebank Botanicals')).toMatchObject({ status: 'approved', owner: { email: 'merchant1@cloud9.africa' } });
  });
});
