import { describe, it, expect } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');
const orders = require('../src/orders');
const { licenceSweep } = require('../src/staff');

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const owner = t.api(await t.login('merchant1@clicknpuff.africa'));
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  await admin.put('/api/admin/settings', { deliveryOpenHour: 0, deliveryCloseHour: 24 });
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const loginWith = async (email, password) => (await request(t.app).post('/api/auth/login').send({ email, password })).body.token;
  const hire = async (role, email = `${role}@rosebank.test`) => {
    const r = await owner.post('/api/merchant/team', { name: `Pat ${role}`, email, role });
    expect(r.status).toBe(201);
    return t.api(await loginWith(email, r.body.temporaryPassword));
  };
  const place = async () => {
    const p = store.products.find((x) => x.stock >= 10);
    const res = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(15000 / p.priceCents) }], ...DROP });
    return (await customer.post(`/api/orders/${res.body.order.id}/pay`)).body.order;
  };
  return { ...t, owner, admin, customer, store, hire, loginWith, place };
}

describe('staff roles', () => {
  it('lets a packer run the board but not the menu or the money', async () => {
    const w = await world();
    const packer = await w.hire('packer');
    expect((await packer.get('/api/merchant/store')).body).toMatchObject({ role: 'packer', store: { id: w.store.store.id } });
    const o = await w.place();
    expect((await packer.get('/api/merchant/orders')).body.live.map((x) => x.id)).toContain(o.id);
    expect((await packer.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted', prepMinutes: 10 })).status).toBe(200);
    const p = w.store.products[0];
    expect((await packer.patch(`/api/merchant/products/${p.id}`, { stock: 4 })).status).toBe(200);
    expect((await packer.patch(`/api/merchant/products/${p.id}`, { priceCents: 100 })).status).toBe(403);
    expect((await packer.patch('/api/merchant/store', { pauseMinutes: 15 })).status).toBe(200);
    expect((await packer.patch('/api/merchant/store', { deliveryRadiusKm: 20 })).status).toBe(403);
    for (const path of ['/api/merchant/payouts', '/api/merchant/billing', '/api/merchant/insights', '/api/merchant/promos', '/api/merchant/team', '/api/merchant/activity']) {
      expect((await packer.get(path)).status, path).toBe(403);
    }
    // They can see the order and its customer details.
    expect((await packer.get(`/api/orders/${o.id}`)).status).toBe(200);
  });

  it('lets a manager run the menu, promos and reviews but not money or staff', async () => {
    const w = await world();
    const manager = await w.hire('manager');
    expect((await manager.post('/api/merchant/products', { name: 'Hemp wick', category: 'accessories', priceCents: 4500, stock: 10 })).status).toBe(201);
    expect((await manager.post('/api/merchant/promos', { code: 'MGR10', kind: 'percent', value: 10 })).status).toBe(201);
    expect((await manager.get('/api/merchant/insights')).status).toBe(200);
    expect((await manager.get('/api/merchant/activity')).status).toBe(200);
    expect((await manager.get('/api/merchant/payouts')).status).toBe(403);
    expect((await manager.put('/api/merchant/bank', { bankName: 'FNB', accountHolder: 'X', accountNumber: '62000000000', password: 'password123' })).status).toBe(403);
    expect((await manager.post('/api/merchant/team', { name: 'Sneaky', email: 'sneaky@x.test', role: 'manager' })).status).toBe(403);
    expect((await manager.post('/api/merchant/store', { name: 'Side hustle', city: 'johannesburg', address: '1 Main Rd' })).status).toBe(403);
  });

  it('adds, re-roles and removes staff, never the owner, and refuses customer emails', async () => {
    const w = await world();
    expect((await w.owner.post('/api/merchant/team', { name: 'Naledi', email: 'customer@clicknpuff.africa', role: 'packer' })).status).toBe(409);
    expect((await w.owner.post('/api/merchant/team', { name: 'Boss', email: 'boss@x.test', role: 'owner' })).status).toBe(400);
    const packer = await w.hire('packer');
    const list = (await w.owner.get('/api/merchant/team')).body.members;
    expect(list.map((m) => m.role)).toEqual(['owner', 'packer']);
    const id = list[1].id;
    expect(list[1].invited).toBe(true);
    await w.owner.patch(`/api/merchant/team/${id}`, { role: 'manager' });
    expect((await packer.get('/api/merchant/insights')).status).toBe(200);
    const ownerId = list[0].id;
    expect((await w.owner.delete(`/api/merchant/team/${ownerId}`)).status).toBe(400);
    await w.owner.delete(`/api/merchant/team/${id}`);
    expect((await packer.get('/api/merchant/orders')).body.live).toEqual([]);
    expect((await packer.get('/api/merchant/store')).body.store).toBeNull();

    const log = (await w.owner.get('/api/merchant/activity')).body.entries.map((e) => e.action);
    expect(log).toEqual(expect.arrayContaining(['staff_added', 'staff_role', 'staff_removed']));
  });

  it('notifies the whole team about a new order', async () => {
    const sent = [];
    const t = await setup();
    const { createApp } = require('../src/app');
    const app = createApp(t.db, { pushSend: async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); } });
    const api = (token) => ({ post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${token}`).send(b || {}) });
    const tok = async (email, password = 'password123') => (await request(app).post('/api/auth/login').send({ email, password })).body.token;
    const owner = api(await tok('merchant1@clicknpuff.africa'));
    const hired = await owner.post('/api/merchant/team', { name: 'Pat', email: 'pat@rosebank.test', role: 'packer' });
    const packer = api(await tok('pat@rosebank.test', hired.body.temporaryPassword));
    const sub = (n) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
    await owner.post('/api/push/subscribe', { subscription: sub('owner') });
    await packer.post('/api/push/subscribe', { subscription: sub('packer') });
    const customer = api(await tok('customer@clicknpuff.africa'));
    const store = (await request(app).get('/api/stores/rosebank-botanicals')).body;
    const p = store.products.find((x) => x.stock >= 10);
    const o = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(15000 / p.priceCents) }], ...DROP });
    await customer.post(`/api/orders/${o.body.order.id}/pay`);
    await new Promise((r) => setTimeout(r, 20));
    const got = sent.filter((s) => s.payload.title.startsWith('New order')).map((s) => s.endpoint).sort();
    expect(got).toEqual(['https://push.example/owner', 'https://push.example/packer']);
  });
});

describe('branches', () => {
  it('lets an owner run several stores, switching with X-Store-Id, and keeps staff to their branch', async () => {
    const w = await world();
    const made = await w.owner.post('/api/merchant/store', { name: 'Rosebank Botanicals Sandton', city: 'johannesburg', address: '1 Rivonia Rd, Sandton', lat: -26.107, lng: 28.057 });
    expect(made.status).toBe(201);
    const second = made.body.store.id;
    const me = (await w.owner.get('/api/merchant/store')).body;
    expect(me.stores.map((s) => s.id)).toEqual([w.store.store.id, second]);
    expect(me.store.id).toBe(w.store.store.id); // first by default
    expect((await w.owner.get('/api/merchant/store').set('X-Store-Id', String(second))).body.store.name).toBe('Rosebank Botanicals Sandton');
    expect((await w.owner.post('/api/merchant/products', { name: 'Sandton only', category: 'accessories', priceCents: 1000, stock: 3 }).set('X-Store-Id', String(second))).status).toBe(201);
    const sandton = (await w.owner.get('/api/merchant/products').set('X-Store-Id', String(second))).body.products;
    expect(sandton.map((p) => p.name)).toEqual(['Sandton only']);

    // A packer at Rosebank can't reach Sandton by asking for it.
    const packer = await w.hire('packer');
    expect((await packer.get('/api/merchant/store').set('X-Store-Id', String(second))).body.store.id).toBe(w.store.store.id);
    expect((await packer.get('/api/merchant/products').set('X-Store-Id', String(second))).body.products.some((p) => p.name === 'Sandton only')).toBe(false);
  });
});

describe('customer insights and reviews', () => {
  it('counts new and returning customers, repeat rate and suburbs', async () => {
    const w = await world();
    const sid = w.store.store.id;
    const cust = w.db.prepare("SELECT id FROM users WHERE email = 'customer@clicknpuff.africa'").get().id;
    const ins = w.db.prepare(`INSERT INTO orders (code, customer_id, store_id, status, subtotal_cents, delivery_fee_cents, service_fee_cents, total_cents, vat_cents, address, lat, lng, distance_km, eta_minutes, handover_code, delivered_at)
      VALUES (?, ?, ?, 'delivered', ?, 2500, 1000, ?, 0, ?, -26.14, 28.04, 2, 30, '1234', datetime('now', ?))`);
    const other = w.db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES ('new@x.test', 'x', 'New Person', 'customer')").run().lastInsertRowid;
    ins.run('OLD1', cust, sid, 20000, 23500, '5 Tyrwhitt Ave, Rosebank', '-60 days'); // an earlier visit
    ins.run('NOW1', cust, sid, 30000, 33500, '5 Tyrwhitt Ave, Rosebank', '-1 days');
    ins.run('NOW2', other, sid, 10000, 13500, '9 Jan Smuts Ave, Parktown North, Johannesburg, 2193', '-2 days');
    const c = (await w.owner.get('/api/merchant/insights?days=7')).body.customers;
    expect(c).toMatchObject({ total: 2, new: 1, returning: 1, repeatRate: 50 });
    expect(c.topSuburbs.map((s) => s.suburb)).toEqual(['Rosebank', 'Parktown North']);
  });

  it('flags low ratings to the team and counts reviews waiting for a reply', async () => {
    const w = await world();
    const o = await w.place();
    w.db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(o.id);
    const seen = [];
    const on = (storeId, rating) => seen.push([storeId, rating]);
    orders.bus.on('low_rating', on);
    try {
      await w.customer.post(`/api/orders/${o.id}/review`, { rating: 2, comment: 'Arrived late and the lid was cracked' });
    } finally { orders.bus.off('low_rating', on); }
    expect(seen).toEqual([[w.store.store.id, 2]]);
    expect((await w.owner.get('/api/merchant/alerts')).body.alerts.reviewsToReply).toBe(1);
    const r = (await w.owner.get('/api/merchant/reviews')).body.reviews[0];
    await w.owner.post(`/api/merchant/reviews/${r.id}/reply`, { reply: "We're sorry — a new grinder is on its way." });
    expect((await w.owner.get('/api/merchant/alerts')).body.alerts.reviewsToReply).toBe(0);
  });
});

describe('licence expiry', () => {
  it('reminds at 60, 30 and 7 days once each, then hides regulated products when it lapses', async () => {
    const w = await world();
    const sid = w.store.store.id;
    await w.admin.put('/api/admin/settings', { regulatedSalesEnabled: true });
    await w.admin.post(`/api/admin/stores/${sid}`, { licenceVerified: true, licenceCategories: ['flower'], licenceExpiresOn: '2027-01-31' });
    const flower = async () => (await request(w.app).get('/api/stores/rosebank-botanicals')).body.products.some((p) => p.category.slug === 'flower');
    expect(await flower()).toBe(true);

    const steps = [];
    const on = (storeId, step) => storeId === sid && steps.push(step);
    orders.bus.on('licence', on);
    try {
      const at = (d) => licenceSweep(w.db, new Date(`${d}T08:00:00Z`));
      at('2026-11-01'); // 91 days out: nothing
      at('2026-12-02'); // 60
      at('2026-12-03'); // still 60: not again
      at('2027-01-01'); // 30
      at('2027-01-25'); // 7
      at('2027-01-31'); // last valid day: nothing new
      at('2027-02-01'); // expired
      at('2027-02-02');
    } finally { orders.bus.off('licence', on); }
    expect(steps).toEqual(['60', '30', '7', 'expired']);

    // Today is past an expiry date: regulated products disappear by themselves.
    await w.admin.post(`/api/admin/stores/${sid}`, { licenceExpiresOn: '2020-01-01' });
    expect(await flower()).toBe(false);
    const queue = (await w.admin.get('/api/admin/dashboard')).body.actions;
    expect(queue.some((a) => a.type === 'licence_expiry')).toBe(true);
    expect((await w.owner.get('/api/merchant/alerts')).body.alerts.licence).toMatchObject({ expired: true });

    // The store puts in its renewal: back to the review queue until verified.
    await w.owner.patch('/api/merchant/store', { licenceExpiresOn: '2028-01-31' });
    expect(w.db.prepare('SELECT licence_verified, licence_reminded FROM stores WHERE id = ?').get(sid)).toEqual({ licence_verified: 0, licence_reminded: null });
    await w.admin.post(`/api/admin/stores/${sid}`, { licenceVerified: true });
    expect(await flower()).toBe(true);
  });
});
