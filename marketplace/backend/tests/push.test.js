import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };
const sub = (n) => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: `p256-${n}`, auth: `auth-${n}` } });
const flush = () => new Promise((r) => setImmediate(r));

async function world() {
  const db = open(':memory:');
  await seed(db);
  const sent = [];
  const pushSend = vi.fn(async (s, payload) => { sent.push({ endpoint: s.endpoint, ...JSON.parse(payload) }); });
  const app = createApp(db, { pushSend });
  const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'password123' })).body.token;
  const as = (t) => ({
    get: (u) => request(app).get(u).set('Authorization', `Bearer ${t}`),
    post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${t}`).send(b || {}),
  });
  const customer = as(await login('customer@clicknpuff.africa'));
  const merchant = as(await login('merchant1@clicknpuff.africa'));
  const rider = as(await login('rider1@clicknpuff.africa'));
  const store = (await request(app).get('/api/stores/rosebank-botanicals')).body;
  const p = store.products.find((x) => x.stock >= 10);
  const place = async () => {
    const c = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(10000 / p.priceCents) }], ...DROP });
    return (await customer.post(`/api/orders/${c.body.order.id}/pay`)).body.order;
  };
  return { db, app, sent, pushSend, customer, merchant, rider, place };
}

describe('push notifications', () => {
  it('hands out a stable public key and stores subscriptions', async () => {
    const w = await world();
    const k1 = (await request(w.app).get('/api/push/key')).body.publicKey;
    expect(k1).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // A second app on the same database keeps the same key.
    expect((await request(createApp(w.db)).get('/api/push/key')).body.publicKey).toBe(k1);
    expect((await w.customer.post('/api/push/subscribe', { subscription: { endpoint: 'http://not-secure' } })).status).toBe(400);
    expect((await w.customer.post('/api/push/subscribe', { subscription: sub(1) })).status).toBe(201);
    expect((await request(w.app).post('/api/push/subscribe').send({ subscription: sub(2) })).status).toBe(401);
  });

  it('tells the customer as the order moves, and the store when it arrives', async () => {
    const w = await world();
    await w.customer.post('/api/push/subscribe', { subscription: sub('cust') });
    await w.merchant.post('/api/push/subscribe', { subscription: sub('store') });
    await w.rider.post('/api/push/subscribe', { subscription: sub('rider') });
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });

    const o = await w.place();
    await flush();
    expect(w.sent.find((m) => m.endpoint.endsWith('/store'))).toMatchObject({ title: `New order #${o.code}`, url: '/merchant', urgent: true });

    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 });
    await flush();
    const offer = w.sent.find((m) => m.endpoint.endsWith('/rider'));
    expect(offer).toMatchObject({ url: '/rider', tag: 'rider-offer', offer: true });
    expect(offer.title).toMatch(/^New trip · R\d+/);

    await w.rider.post(`/api/rider/offers/${o.id}/accept`);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    await w.rider.post(`/api/rider/jobs/${o.id}/pickup`, { bagCode: o.code.slice(-4) });
    await w.rider.post(`/api/rider/jobs/${o.id}/arrived`);
    await w.rider.post(`/api/rider/jobs/${o.id}/deliver`, { handoverCode: o.handoverCode, idChecked: true });
    await flush();
    const toCustomer = w.sent.filter((m) => m.endpoint.endsWith('/cust')).map((m) => m.title);
    expect(toCustomer).toEqual(['Order accepted 👍', 'Packed and ready', 'On the way 🛵', 'Your rider is outside 👋', 'Delivered — enjoy!']);
    expect(w.sent.filter((m) => m.endpoint.endsWith('/cust')).every((m) => m.url === `/orders/${o.id}`)).toBe(true);
  });

  it('forgets subscriptions the push service says are gone', async () => {
    const w = await world();
    await w.customer.post('/api/push/subscribe', { subscription: sub('old') });
    w.pushSend.mockImplementation(async () => { const e = new Error('gone'); e.statusCode = 410; throw e; });
    expect((await w.customer.post('/api/push/test')).body.sent).toBe(0);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n).toBe(0);
  });

  it('moves a browser to whoever signs in on it, and lets them switch off', async () => {
    const w = await world();
    await w.customer.post('/api/push/subscribe', { subscription: sub('shared') });
    await w.rider.post('/api/push/subscribe', { subscription: sub('shared') });
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n).toBe(1);
    expect((await w.rider.post('/api/push/test')).body.sent).toBe(1);
    expect((await w.customer.post('/api/push/test')).body.sent).toBe(0);
    await w.rider.post('/api/push/unsubscribe', { endpoint: sub('shared').endpoint });
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n).toBe(0);
  });
});
