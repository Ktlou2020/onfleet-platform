import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const request = require('supertest');
const { setup } = require('./helpers');

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-05T10:00:00Z'), toFake: ['Date'] }));
afterEach(() => vi.useRealTimers());

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };

async function world() {
  const t = await setup();
  const admin = t.api(await t.login('admin@clicknpuff.africa'));
  const customer = t.api(await t.login('customer@clicknpuff.africa'));
  const merchant = t.api(await t.login('merchant1@clicknpuff.africa'));
  const rider = t.api(await t.login('rider1@clicknpuff.africa'));
  const store = (await request(t.app).get('/api/stores/rosebank-botanicals')).body;
  const order = async (status = 'accepted') => {
    const p = store.products.find((x) => x.stock >= 10);
    const created = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(10000 / p.priceCents) }], ...DROP });
    const o = (await customer.post(`/api/orders/${created.body.order.id}/pay`)).body.order;
    if (status !== 'placed') await merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'accepted' });
    return o;
  };
  return { ...t, admin, customer, merchant, rider, store, order };
}

describe('admin profile and team', () => {
  it('edits your own profile and changes your password', async () => {
    const w = await world();
    const me = (await w.admin.patch('/api/me', { name: 'Kagi Ops', phone: '082 555 1234' })).body.user;
    expect(me).toMatchObject({ name: 'Kagi Ops', phone: '082 555 1234' });
    expect((await w.admin.patch('/api/me', { phone: 'not a phone' })).status).toBe(400);
    expect((await w.admin.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'a-much-longer-one' })).status).toBe(400);
    expect((await w.admin.post('/api/me/password', { currentPassword: 'password123', newPassword: 'short' })).status).toBe(400);
    expect((await w.admin.post('/api/me/password', { currentPassword: 'password123', newPassword: 'a-much-longer-one' })).status).toBe(200);
    expect((await request(w.app).post('/api/auth/login').send({ email: 'admin@clicknpuff.africa', password: 'a-much-longer-one' })).status).toBe(200);
    const mine = (await w.admin.get('/api/admin/audit?mine=1')).body.entries.map((e) => e.action);
    expect(mine).toEqual(expect.arrayContaining(['password_changed', 'profile_updated']));
  });

  it('remembers the previous sign-in', async () => {
    const w = await world();
    const again = (await request(w.app).post('/api/auth/login').send({ email: 'admin@clicknpuff.africa', password: 'password123' })).body.user;
    expect(again.lastLoginAt).toBeTruthy(); // the sign-in from world()
  });

  it('adds an admin with a one-time password they must change', async () => {
    const w = await world();
    const added = (await w.admin.post('/api/admin/team', { name: 'Thandi Support', email: 'thandi@clicknpuff.africa' })).body;
    expect(added.temporaryPassword).toHaveLength(12);
    const login = (await request(w.app).post('/api/auth/login').send({ email: 'thandi@clicknpuff.africa', password: added.temporaryPassword })).body;
    expect(login.user).toMatchObject({ role: 'admin', mustChangePassword: true });
    expect((await w.admin.post('/api/admin/team', { name: 'Dup', email: 'thandi@clicknpuff.africa' })).status).toBe(409);

    const team = (await w.admin.get('/api/admin/team')).body.team;
    expect(team.find((m) => m.you)).toMatchObject({ email: 'admin@clicknpuff.africa', active: true });
    const me = team.find((m) => m.you);
    expect((await w.admin.post(`/api/admin/team/${me.id}/access`, { active: false })).status).toBe(400);
    expect((await w.admin.post(`/api/admin/team/${added.id}/access`, { active: false })).status).toBe(200);
    expect((await request(w.app).post('/api/auth/login').send({ email: 'thandi@clicknpuff.africa', password: added.temporaryPassword })).status).toBe(403);
  });

  it('keeps the admin area to admins', async () => {
    const w = await world();
    for (const path of ['/api/admin/dashboard', '/api/admin/live', '/api/admin/team', '/api/admin/audit', '/api/admin/customers']) {
      expect((await w.customer.get(path)).status).toBe(403);
    }
  });
});

describe('control room', () => {
  it('reports today against yesterday and flags what needs attention', async () => {
    const w = await world();
    await w.order('placed');
    w.db.prepare("UPDATE orders SET updated_at = datetime('now', '-10 minutes')").run();
    const d = (await w.admin.get('/api/admin/dashboard')).body;
    expect(d.today.ordersPlaced).toBe(1);
    expect(d.yesterday.ordersPlaced).toBe(0);
    expect(d.days).toHaveLength(14);
    expect(d.days[13].placed).toBe(1);
    expect(d.hourly).toHaveLength(24);
    expect(d.actions.map((a) => a.type)).toContain('store_slow');
  });

  it('works out net revenue after paying riders', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const o = await w.order();
    await w.rider.post(`/api/rider/offers/${o.id}/accept`);
    await w.merchant.post(`/api/merchant/orders/${o.id}/status`, { status: 'ready' });
    await w.rider.post(`/api/rider/jobs/${o.id}/pickup`);
    await w.rider.post(`/api/rider/jobs/${o.id}/deliver`, { handoverCode: o.handoverCode, idChecked: true });
    const row = w.db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id);
    const d = (await w.admin.get('/api/admin/dashboard')).body;
    expect(d.today).toMatchObject({ ordersDelivered: 1, gmvCents: row.total_cents, netRevenueCents: row.service_fee_cents + row.delivery_fee_cents - row.rider_payout_cents });
    expect(d.topStores[0]).toMatchObject({ name: 'Rosebank Botanicals', orders: 1 });
  });

  it('shows active orders and online riders on the live map', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const o = await w.order();
    const live = (await w.admin.get('/api/admin/live')).body;
    expect(live.orders.map((x) => x.id)).toContain(o.id);
    expect(live.riders[0]).toMatchObject({ name: 'Johannesburg Rider', lat: -26.146 });
    expect(live.stores.length).toBeGreaterThan(0);
  });

  it('filters and searches orders, and shows the offer history', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const o = await w.order();
    await w.rider.post(`/api/rider/offers/${o.id}/decline`);
    expect((await w.admin.get('/api/admin/orders?status=needs_rider')).body.orders.map((x) => x.id)).toContain(o.id);
    expect((await w.admin.get('/api/admin/orders?status=delivered')).body.orders).toHaveLength(0);
    expect((await w.admin.get(`/api/admin/orders?q=${o.code}`)).body.orders).toHaveLength(1);
    expect((await w.admin.get('/api/admin/orders?q=Naledi')).body.orders.length).toBeGreaterThan(0);
    const detail = (await w.admin.get(`/api/admin/orders/${o.id}`)).body;
    expect(detail.offers).toEqual([expect.objectContaining({ outcome: 'declined', name: 'Johannesburg Rider' })]);
    expect(detail.customer.email).toBe('customer@clicknpuff.africa');
  });

  it('takes an uncollected order off a rider and offers it to someone else', async () => {
    const w = await world();
    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const o = await w.order();
    await w.rider.post(`/api/rider/offers/${o.id}/accept`);
    const r = await w.admin.post(`/api/admin/orders/${o.id}/reassign`, { reason: 'Rider not moving' });
    expect(r.body.order.rider).toBeNull();
    expect((await w.rider.get('/api/rider/jobs')).body.current).toHaveLength(0);
    expect((await w.rider.get('/api/rider/jobs')).body.offer).toBeNull(); // not offered back to them
    expect((await w.admin.post(`/api/admin/orders/${o.id}/reassign`)).status).toBe(409);
  });

  it('lists and suspends customers, and takes a suspended rider offline', async () => {
    const w = await world();
    const list = (await w.admin.get('/api/admin/customers?q=naledi')).body.customers;
    expect(list[0]).toMatchObject({ email: 'customer@clicknpuff.africa', suspended: false });
    await w.admin.post(`/api/admin/users/${list[0].id}/suspend`, { suspended: true });
    expect((await w.customer.get('/api/me')).status).toBe(401);

    await w.rider.post('/api/rider/status', { online: true, lat: -26.146, lng: 28.043 });
    const riderId = w.db.prepare("SELECT id FROM users WHERE email = 'rider1@clicknpuff.africa'").get().id;
    await w.admin.post(`/api/admin/users/${riderId}/suspend`, { suspended: true });
    expect(w.db.prepare('SELECT online FROM riders WHERE user_id = ?').get(riderId).online).toBe(0);
    const adminId = w.db.prepare("SELECT id FROM users WHERE email = 'admin@clicknpuff.africa'").get().id;
    expect((await w.admin.post(`/api/admin/users/${adminId}/suspend`, { suspended: true })).status).toBe(400);
  });
});
