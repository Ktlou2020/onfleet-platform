import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const { riderPayoutCents, expireOffers } = require('../src/orders');

// Midday SAST, inside delivery hours. Only JS Date is faked; SQLite keeps
// the real clock, which is what offer expiry and earnings run on.
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };
const NEAR_STORE = { lat: -26.146, lng: 28.043 };

async function world() {
  const t = await setup();
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const rider = t.api(await t.login('rider1@clicknpuff.africa'));
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  // A second Jo'burg rider, a little further from the store.
  const reg = await request(t.app).post('/api/auth/register').send({ email: 'rider-b@x.co.za', password: 'longenough', name: 'Second Rider', role: 'rider' });
  t.db.prepare("UPDATE users SET age_verified = 1, dob = '1990-01-01' WHERE email = 'rider-b@x.co.za'").run();
  const rider2 = t.api(reg.body.token);
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  return { ...t, customer, merchant, rider, rider2, admin, store };
}

async function acceptedOrder(w, { tipCents = 0 } = {}) {
  const p = w.store.products.find((x) => x.stock >= 10);
  const qty = Math.ceil(10000 / p.priceCents);
  const created = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty }], tipCents, ...DROP });
  expect(created.status).toBe(201);
  const order = (await w.customer.post(`/api/orders/${created.body.order.id}/pay`)).body.order;
  await w.merchant.post(`/api/merchant/orders/${order.id}/status`, { status: 'accepted' });
  return order;
}

const expireNow = (w, id) => {
  w.db.prepare("UPDATE orders SET offer_expires_at = datetime('now', '-1 second') WHERE id = ?").run(id);
  expireOffers(w.db);
};

describe('trip offers', () => {
  it('offers to the nearest rider with pay, distances and a countdown', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    await w.rider2.post('/api/rider/status', { online: true, lat: -26.17, lng: 28.06 });
    const order = await acceptedOrder(w, { tipCents: 2000 });

    const near = (await w.rider.get('/api/rider/jobs')).body;
    expect(near.offer).toMatchObject({ id: order.id, tipCents: 2000, storeReady: false });
    expect(near.offer.secondsLeft).toBeGreaterThan(20);
    expect(near.offer.payoutCents).toBe(riderPayoutCents(near.offer.pickupKm, near.offer.dropoffKm));
    expect(near.offer.totalCents).toBe(near.offer.payoutCents + 2000);
    expect(near.offer).not.toHaveProperty('dropoff'); // exact address hidden until accepted
    expect((await w.rider2.get('/api/rider/jobs')).body.offer).toBeNull();
  });

  it('moves a declined offer to the next rider, and never back', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    await w.rider2.post('/api/rider/status', { online: true, lat: -26.17, lng: 28.06 });
    const order = await acceptedOrder(w);

    await w.rider.post(`/api/rider/offers/${order.id}/decline`);
    expect((await w.rider2.get('/api/rider/jobs')).body.offer?.id).toBe(order.id);
    await w.rider2.post(`/api/rider/offers/${order.id}/decline`);
    expect((await w.rider.get('/api/rider/jobs')).body.offer).toBeNull();
    // Still on the job board for anyone to take.
    expect((await w.rider.get('/api/rider/jobs')).body.board.map((j) => j.id)).toContain(order.id);
  });

  it('expires an unanswered offer and passes it on', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    await w.rider2.post('/api/rider/status', { online: true, lat: -26.17, lng: 28.06 });
    const order = await acceptedOrder(w);
    expireNow(w, order.id);
    expect((await w.rider.post(`/api/rider/offers/${order.id}/accept`)).status).toBe(409);
    expect((await w.rider2.get('/api/rider/jobs')).body.offer?.id).toBe(order.id);
    const log = w.db.prepare('SELECT outcome FROM offer_log WHERE order_id = ? ORDER BY id').all(order.id).map((r) => r.outcome);
    expect(log).toEqual(['expired']);
  });

  it('sends no offers to a paused rider, and pausing hands back the one on screen', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    const order = await acceptedOrder(w);
    expect((await w.rider.get('/api/rider/jobs')).body.offer?.id).toBe(order.id);
    const paused = (await w.rider.post('/api/rider/status', { paused: true })).body;
    expect(paused.rider).toMatchObject({ online: true, paused: true });
    expect(paused.offer).toBeNull();
    const again = (await w.rider.post('/api/rider/status', { paused: false })).body;
    expect(again.offer).toBeNull(); // already passed on this order
  });

  it('offers waiting orders when a rider comes online', async () => {
    const w = await world();
    const order = await acceptedOrder(w);
    const res = (await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE })).body;
    expect(res.offer?.id).toBe(order.id);
  });
});

describe('a trip, step by step', () => {
  it('records arrivals, tells the customer, and pays the rider with the tip', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    const order = await acceptedOrder(w, { tipCents: 3000 });
    expect(order.totals).toMatchObject({ tipCents: 3000, totalCents: order.totals.subtotalCents + order.totals.deliveryFeeCents + order.totals.serviceFeeCents + 3000 });

    const jobs = (await w.rider.post(`/api/rider/offers/${order.id}/accept`)).body;
    expect(jobs.current[0].pay.tipCents).toBe(3000);
    expect(jobs.current[0].customer.phone).toBeUndefined(); // not until collected

    await w.rider.post(`/api/rider/jobs/${order.id}/arrived-store`);
    expect((await w.rider.post(`/api/rider/jobs/${order.id}/arrived`)).status).toBe(409); // not collected yet
    await w.merchant.post(`/api/merchant/orders/${order.id}/status`, { status: 'ready' });
    const collected = (await w.rider.post(`/api/rider/jobs/${order.id}/pickup`, { bagCode: order.code.slice(-4) })).body.current[0];
    expect(collected.customer.phone).toBeTruthy();
    await w.rider.post(`/api/rider/jobs/${order.id}/arrived`);

    const seen = (await w.customer.get(`/api/orders/${order.id}`)).body.order;
    expect(seen.events.map((e) => e.status)).toEqual(expect.arrayContaining(['rider_assigned', 'rider_at_store', 'picked_up', 'rider_arrived']));
    expect(seen.milestones.arrivedCustomerAt).toBeTruthy();
    expect(seen.rider.location).toMatchObject(NEAR_STORE);

    const done = (await w.rider.post(`/api/rider/jobs/${order.id}/deliver`, { handoverCode: seen.handoverCode, idChecked: true })).body;
    expect(done.completed.status).toBe('delivered');
    expect(done.today.trips).toBe(1);
    expect(done.today.earningsCents).toBe(done.completed.pay.payoutCents + 3000);
    expect(done.today.tipsCents).toBe(3000);

    await w.customer.post(`/api/orders/${order.id}/review`, { rating: 5, riderRating: 4 });
    const earnings = (await w.rider.get('/api/rider/earnings')).body;
    expect(earnings.stats).toMatchObject({ rating: 4, ratingCount: 1, acceptanceRate: 100, completionRate: 100, lifetimeTrips: 1 });
    expect(earnings.trips[0]).toMatchObject({ id: order.id, tipCents: 3000, rating: 4 });
    expect(earnings.week).toHaveLength(7);
    expect(earnings.week[6].tipsCents).toBe(3000);
  });

  it('returns an undeliverable order: waits for a no-show, restocks, refunds, still pays', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    const order = await acceptedOrder(w);
    const productId = order.items[0].product_id;
    const stockBefore = w.db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock;
    await w.rider.post(`/api/rider/offers/${order.id}/accept`);
    await w.merchant.post(`/api/merchant/orders/${order.id}/status`, { status: 'ready' });
    await w.rider.post(`/api/rider/jobs/${order.id}/pickup`, { bagCode: order.code.slice(-4) });

    expect((await w.rider.post(`/api/rider/jobs/${order.id}/return`, { reason: 'no_answer' })).status).toBe(409); // not arrived
    await w.rider.post(`/api/rider/jobs/${order.id}/arrived`);
    const early = await w.rider.post(`/api/rider/jobs/${order.id}/return`, { reason: 'no_answer' });
    expect(early.status).toBe(409);
    expect(early.body.waitSecondsLeft).toBeGreaterThan(0);

    w.db.prepare("UPDATE orders SET arrived_customer_at = datetime('now', '-6 minutes') WHERE id = ?").run(order.id);
    const back = (await w.rider.post(`/api/rider/jobs/${order.id}/return`, { reason: 'no_answer' })).body;
    expect(back.completed).toMatchObject({ status: 'returned', paymentStatus: 'refunded' });
    expect(back.current).toHaveLength(0);
    expect(back.today.trips).toBe(1);
    expect(w.db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock).toBe(stockBefore + order.items[0].qty);
    const incidents = (await w.admin.get('/api/admin/incidents')).body.incidents;
    expect(incidents[0]).toMatchObject({ type: 'customer_issue', orderCode: order.code });
  });

  it('lets a rider raise an SOS that admin sees and can resolve', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    expect((await w.rider.post('/api/rider/incidents', { type: 'bogus' })).status).toBe(400);
    expect((await w.rider.post('/api/rider/incidents', { type: 'sos', note: 'Being followed' })).status).toBe(201);
    const [inc] = (await w.admin.get('/api/admin/incidents')).body.incidents;
    expect(inc).toMatchObject({ type: 'sos', resolved: false, location: NEAR_STORE, rider: { name: 'Johannesburg Rider' } });
    expect((await w.admin.get('/api/admin/overview')).body.openIncidents).toBe(1);
    await w.admin.post(`/api/admin/incidents/${inc.id}/resolve`);
    expect((await w.admin.get('/api/admin/overview')).body.openIncidents).toBe(0);
  });

  it('shows busy stores, and keeps one rider to one trip', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    const a = await acceptedOrder(w);
    await w.rider.post(`/api/rider/offers/${a.id}/accept`);
    const b = await acceptedOrder(w);
    expect((await w.rider.get('/api/rider/jobs')).body.offer).toBeNull(); // busy, so no second offer
    const spots = (await w.rider.get('/api/rider/demand')).body.spots;
    expect(spots[0]).toMatchObject({ name: 'Rosebank Botanicals', waiting: 1, level: 'high' });
    expect((await w.rider.post(`/api/rider/jobs/${b.id}/claim`)).status).toBe(409);
  });

  it('rejects silly tips and lists riders for admin', async () => {
    const w = await world();
    const p = w.store.products[0];
    const bad = await w.customer.post('/api/orders', { storeId: w.store.store.id, items: [{ productId: p.id, qty: 5 }], tipCents: 999999, ...DROP });
    expect(bad.status).toBe(400);
    await w.rider.post('/api/rider/status', { online: true, ...NEAR_STORE });
    await w.rider.patch('/api/rider/profile', { vehicle: 'scooter', plate: 'cy 123-456' });
    const riders = (await w.admin.get('/api/admin/riders')).body.riders;
    expect(riders.find((r) => r.name === 'Johannesburg Rider')).toMatchObject({ online: true, vehicle: 'scooter', plate: 'CY 123-456' });
  });
});

describe('upgrading a database already in use', () => {
  it('adds the new columns once and leaves data alone', () => {
    const { open } = require('../src/db');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c9-')), 'old.db');
    const first = open(file);
    first.prepare("INSERT INTO cities (slug, name, lat, lng) VALUES ('x', 'X', 0, 0)").run();
    first.close();
    const second = open(file);
    expect(second.prepare('SELECT COUNT(*) AS n FROM cities').get().n).toBe(1);
    expect(second.prepare('PRAGMA table_info(orders)').all().map((c) => c.name)).toEqual(expect.arrayContaining(['tip_cents', 'offered_rider_id', 'arrived_customer_at']));
    second.close();
  });
});
