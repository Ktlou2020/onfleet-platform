import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
const request = require('supertest');
const { setup, saId } = require('./helpers');

// Midday SAST, inside delivery hours.
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const ROSEBANK_DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const rider = t.api(await t.login('rider1@clicknpuff.africa'));
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  return { ...t, customer, merchant, rider, admin, store };
}

async function placePaidOrder(w, qty = 2) {
  const product = w.store.products.find((p) => p.inStock && p.priceCents * qty >= 10000) || w.store.products[0];
  const created = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: product.id, qty: Math.max(qty, Math.ceil(10000 / product.priceCents)) }], ...ROSEBANK_DROP });
  expect(created.status).toBe(201);
  const paid = await w.customer.post(`/api/orders/${created.body.order.id}/pay`);
  expect(paid.body.order.status).toBe('placed');
  return paid.body.order;
}

describe('catalogue', () => {
  it('hides regulated products until switched on and licensed', async () => {
    const w = await world();
    expect(w.store.products.some((p) => p.category.slug === 'flower')).toBe(false);
    expect(w.store.products.some((p) => p.category.slug === 'papers')).toBe(true);

    await w.admin.put('/api/admin/settings', { regulatedSalesEnabled: true });
    let s = (await request(w.app).get('/api/stores/rosebank-botanicals')).body;
    expect(s.products.some((p) => p.category.slug === 'flower')).toBe(false); // still unverified

    await w.admin.post(`/api/admin/stores/${w.store.store.id}`, { licenceVerified: true, licenceCategories: ['flower'] });
    s = (await request(w.app).get('/api/stores/rosebank-botanicals')).body;
    expect(s.products.some((p) => p.category.slug === 'flower')).toBe(true);
    expect(s.products.some((p) => p.category.slug === 'edibles')).toBe(false); // not covered
  });

  it('quotes distance, fees and ETA from the drop-off point', async () => {
    const w = await world();
    const stores = (await request(w.app).get('/api/stores').query({ city: 'johannesburg', lat: ROSEBANK_DROP.lat, lng: ROSEBANK_DROP.lng })).body.stores;
    expect(stores[0]).toMatchObject({ slug: 'rosebank-botanicals', delivers: true });
    expect(stores[0].etaMinutes).toBeGreaterThan(0);
  });
});

describe('ordering', () => {
  it('requires a verified adult to order', async () => {
    const t = await setup();
    const reg = await request(t.app).post('/api/auth/register').send({ email: 'new@x.co.za', password: 'longenough', name: 'New Person' });
    const api = t.api(reg.body.token);
    const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
    const order = { storeId: store.store.id, items: [{ productId: store.products[0].id, qty: 5 }], ...ROSEBANK_DROP };

    expect((await api.post('/api/orders', order)).body.code).toBe('AGE_UNVERIFIED');
    expect((await api.post('/api/me/verify-age', { idNumber: saId('100101') })).status).toBe(403); // 16
    expect((await api.post('/api/me/verify-age', { idNumber: saId('950615') })).body.user.ageVerified).toBe(true);
    expect((await api.post('/api/orders', order)).status).toBe(201);
  });

  it('runs end to end: pay, accept, dispatch, pick up, hand over with ID and code', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const order = await placePaidOrder(w);

    // Another store cannot touch it.
    const other = w.api(await w.login('merchant2@clicknpuff.africa'));
    expect((await other.post(`/api/merchant/orders/${order.id}/status`, { status: 'accepted' })).status).toBe(404);

    const accepted = await w.merchant.post(`/api/merchant/orders/${order.id}/status`, { status: 'accepted' });
    expect(accepted.body.order.rider).toBeNull(); // offered, not yet taken
    const jobs = (await w.rider.get('/api/rider/jobs')).body;
    expect(jobs.offer).toMatchObject({ id: order.id, secondsLeft: expect.any(Number) });
    await w.rider.post(`/api/rider/offers/${order.id}/accept`);
    expect((await w.merchant.get(`/api/orders/${order.id}`)).body.order.rider?.name).toBe('Johannesburg Rider');
    expect(accepted.body.order.handoverCode).toBeUndefined();

    expect((await w.rider.post(`/api/rider/jobs/${order.id}/pickup`, { bagCode: order.code.slice(-4) })).status).toBe(409); // not ready yet
    await w.merchant.post(`/api/merchant/orders/${order.id}/status`, { status: 'ready' });
    expect((await w.rider.post(`/api/rider/jobs/${order.id}/pickup`, { bagCode: order.code.slice(-4) })).body.current[0].status).toBe('picked_up');

    expect((await w.rider.post(`/api/rider/jobs/${order.id}/deliver`, { handoverCode: order.handoverCode })).status).toBe(400); // no ID check
    expect((await w.rider.post(`/api/rider/jobs/${order.id}/deliver`, { handoverCode: '0000x', idChecked: true })).status).toBe(400);
    const done = await w.rider.post(`/api/rider/jobs/${order.id}/deliver`, { handoverCode: order.handoverCode, idChecked: true });
    expect(done.body.completed.status).toBe('delivered');

    const reviewed = await w.customer.post(`/api/orders/${order.id}/review`, { rating: 5, comment: 'Fast!' });
    expect(reviewed.body.order.review.rating).toBe(5);
    expect((await w.customer.post(`/api/orders/${order.id}/review`, { rating: 4 })).status).toBe(409);
  });

  it('reserves stock on order and gives it back on cancel, with a refund flag', async () => {
    const w = await world();
    const stockOf = (id) => w.db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock;
    const product = w.store.products.find((p) => p.stock >= 10);
    const before = stockOf(product.id);
    const qty = Math.ceil(10000 / product.priceCents);
    const created = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: product.id, qty }], ...ROSEBANK_DROP });
    const order = (await w.customer.post(`/api/orders/${created.body.order.id}/pay`)).body.order;
    expect(stockOf(product.id)).toBe(before - qty);

    const cancelled = await w.customer.post(`/api/orders/${order.id}/cancel`, { reason: 'Changed my mind' });
    expect(cancelled.body.order).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded' });
    expect(stockOf(product.id)).toBe(before);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND status = ?').get(order.id, 'cancelled').n).toBe(1);
  });

  it('will not sell more than is in stock', async () => {
    const w = await world();
    const p = w.store.products[0];
    w.db.prepare('UPDATE products SET stock = 1 WHERE id = ?').run(p.id);
    const res = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty: 2 }], ...ROSEBANK_DROP });
    expect(res.status).toBe(409);
  });

  it('refuses addresses outside the delivery radius', async () => {
    const w = await world();
    const res = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: w.store.products[0].id, qty: 5 }], lat: -25.75, lng: 28.23, address: 'Pretoria' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't deliver that far/);
  });

  it('takes orders outside delivery hours and schedules them for the next delivery time', async () => {
    const w = await world();
    vi.setSystemTime(new Date('2026-11-05T21:30:00Z')); // 23:30 SAST; deliveries run 08:00-22:00
    const body = { storeId: w.store.store.id, items: [{ productId: w.store.products[0].id, qty: 5 }], ...ROSEBANK_DROP };
    const q = (await w.customer.post('/api/quote', body)).body.quote;
    expect(q.delivery).toMatchObject({ possible: true, now: false, label: 'tomorrow at 08:00', scheduledFor: '2026-11-06T06:00:00.000Z' });
    const created = await w.customer.post('/api/orders', body);
    expect(created.status).toBe(201);
    const paid = (await w.customer.post(`/api/orders/${created.body.order.id}/pay`)).body.order;
    expect(paid).toMatchObject({ status: 'scheduled', scheduledFor: '2026-11-06T06:00:00.000Z' });
  });

  it('only lets a rider claim one job at a time, and a job only once', async () => {
    const w = await world();
    const a = await placePaidOrder(w);
    const b = await placePaidOrder(w);
    await w.merchant.post(`/api/merchant/orders/${a.id}/status`, { status: 'accepted' });
    await w.merchant.post(`/api/merchant/orders/${b.id}/status`, { status: 'accepted' });
    expect((await w.rider.post(`/api/rider/jobs/${a.id}/claim`)).status).toBe(200);
    expect((await w.rider.post(`/api/rider/jobs/${b.id}/claim`)).status).toBe(409);
    const rider2 = w.api(await w.login('rider2@clicknpuff.africa'));
    expect((await rider2.post(`/api/rider/jobs/${a.id}/claim`)).status).toBe(409);
  });

  it('keeps the handover code and other customers’ orders private', async () => {
    const w = await world();
    const order = await placePaidOrder(w);
    const reg = await request(w.app).post('/api/auth/register').send({ email: 'snoop@x.co.za', password: 'longenough', name: 'Snoop' });
    expect((await w.api(reg.body.token).get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await w.merchant.get(`/api/orders/${order.id}`)).body.order.handoverCode).toBeUndefined();
  });
});
