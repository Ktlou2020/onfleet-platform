import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const { deliveryStart } = require('../src/schedule');
const { releaseScheduled } = require('../src/orders');

const SETTINGS = { deliveryOpenHour: 8, deliveryCloseHour: 22 };
const STORE = { name: 'Test Store', is_open: 1, paused_until: null, hours: null };
const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

describe('when an order can be delivered', () => {
  it('delivers now inside hours, schedules outside them', () => {
    expect(deliveryStart(STORE, SETTINGS, new Date('2026-11-05T10:00:00Z'))).toEqual({ now: true });
    const early = deliveryStart(STORE, SETTINGS, new Date('2026-11-05T03:10:00Z')); // 05:10 SAST
    expect(early).toMatchObject({ now: false, label: 'today at 08:00' });
    expect(early.at.toISOString()).toBe('2026-11-05T06:00:00.000Z');
  });

  it('waits for both the platform and the store to be open', () => {
    const store = { ...STORE, hours: JSON.stringify({ thu: ['14:00', '20:00'], fri: ['10:30', '18:00'] }) };
    // Thursday 21:00 SAST: platform still open, store closed until Friday 10:30.
    const r = deliveryStart(store, SETTINGS, new Date('2026-11-05T19:00:00Z'));
    expect(r).toMatchObject({ now: false, label: 'tomorrow at 10:30' });
    // Thursday 12:00: store opens at 14:00 today.
    expect(deliveryStart(store, SETTINGS, new Date('2026-11-05T10:00:00Z'))).toMatchObject({ label: 'today at 14:00' });
  });

  it('refuses when the store is paused or switched off', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    expect(deliveryStart({ ...STORE, is_open: 0 }, SETTINGS, now).blocked).toMatch(/closed/);
    expect(deliveryStart({ ...STORE, paused_until: '2026-11-05T11:00:00Z' }, SETTINGS, now).blocked).toMatch(/busy/);
  });
});

describe('scheduled orders', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T21:30:00Z'), toFake: ['Date'] })); // 23:30 SAST
  afterEach(() => vi.useRealTimers());

  async function scheduledOrder() {
    const t = await setup();
    const customer = t.api(await t.login('customer@clicknpuff.africa'));
    const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
    const rider = t.api(await t.login('rider1@clicknpuff.africa'));
    const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
    const p = store.products.find((x) => x.stock >= 10);
    const created = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(10000 / p.priceCents) }], ...DROP });
    const order = (await customer.post(`/api/orders/${created.body.order.id}/pay`)).body.order;
    return { ...t, customer, merchant, rider, order };
  }

  it('stays away from the store and riders until delivery time, then goes through', async () => {
    const w = await scheduledOrder();
    expect(w.order.status).toBe('scheduled');
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const board = (await w.merchant.get('/api/merchant/orders')).body;
    expect(board.live).toHaveLength(0);
    expect(board.scheduled.map((o) => o.id)).toEqual([w.order.id]);
    expect((await w.merchant.post(`/api/merchant/orders/${w.order.id}/status`, { status: 'accepted', prepMinutes: 10 })).status).toBe(409);
    expect((await w.rider.get('/api/rider/jobs')).body.offer).toBeNull();

    expect(releaseScheduled(w.db, new Date('2026-11-06T05:59:00Z'))).toBe(0); // 07:59 SAST
    expect(releaseScheduled(w.db, new Date('2026-11-06T06:00:00Z'))).toBe(1); // 08:00 SAST
    const after = (await w.customer.get(`/api/orders/${w.order.id}`)).body.order;
    expect(after.status).toBe('placed');
    expect(after.events.map((e) => e.status)).toEqual(expect.arrayContaining(['scheduled', 'placed']));
    expect((await w.merchant.get('/api/merchant/orders')).body.live[0]).toMatchObject({ id: w.order.id, lane: 'new' });
  });

  it('can be cancelled for a full refund before it goes through', async () => {
    const w = await scheduledOrder();
    const stockBefore = w.db.prepare('SELECT stock FROM products WHERE id = ?').get(w.order.items[0].product_id).stock;
    const r = (await w.customer.post(`/api/orders/${w.order.id}/cancel`, { reason: 'Plans changed' })).body.order;
    expect(r).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    expect(w.db.prepare('SELECT stock FROM products WHERE id = ?').get(w.order.items[0].product_id).stock).toBe(stockBefore + w.order.items[0].qty);
    expect(releaseScheduled(w.db, new Date('2026-11-06T06:00:00Z'))).toBe(0);
  });

  it('still refuses a paused store', async () => {
    const t = await setup();
    const customer = t.api(await t.login('customer@clicknpuff.africa'));
    const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
    await merchant.patch('/api/merchant/store', { pauseMinutes: 60 });
    const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
    const res = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: store.products[0].id, qty: 5 }], ...DROP });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/busy/);
  });
});
