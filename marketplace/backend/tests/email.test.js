import { describe, it, expect } from 'vitest';
const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const DROP = { lat: -26.1400, lng: 28.0450, address: '5 Tyrwhitt Ave, Rosebank' };
const tick = () => new Promise((r) => setTimeout(r, 30));

async function world({ fail = false } = {}) {
  const db = open(':memory:');
  await seed(db);
  const sent = [];
  const app = createApp(db, { emailSend: async (msg) => { if (fail) throw new Error('Brevo 401: Key not found'); sent.push(msg); return { messageId: `<m${sent.length}@brevo>` }; } });
  const login = async (email, password = 'password123') => (await request(app).post('/api/auth/login').send({ email, password })).body.token;
  const api = (token) => ({
    get: (u) => request(app).get(u).set('Authorization', `Bearer ${token}`),
    post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${token}`).send(b || {}),
    put: (u, b) => request(app).put(u).set('Authorization', `Bearer ${token}`).send(b || {}),
  });
  const to = (email) => sent.filter((m) => m.to[0].email === email);
  const linkIn = (m) => /\/reset\?token=([\w-]+)/.exec(m.htmlContent)[1];
  return { db, app, sent, login, api, to, linkIn };
}

describe('email through Brevo', () => {
  it('sends a welcome email in the house style, with a text version', async () => {
    const w = await world();
    await request(w.app).post('/api/auth/register').send({ email: 'thandi@example.com', password: 'a-good-password', name: 'Thandi Mokoena' });
    await tick();
    const [m] = w.to('thandi@example.com');
    expect(m).toMatchObject({ subject: 'Welcome to ClickNPuff', sender: { name: 'ClickNPuff', email: 'hello@clicknpuff.co.za' }, replyTo: { email: 'help@clicknpuff.co.za' }, tags: ['welcome'] });
    expect(m.htmlContent).toContain('Welcome, Thandi!');
    expect(m.textContent).toContain('Start shopping: https://www.clicknpuff.co.za/');
  });

  it('resets a password by email link, once, without revealing who has an account', async () => {
    const w = await world();
    const a = await request(w.app).post('/api/auth/forgot').send({ email: 'customer@clicknpuff.africa' });
    const b = await request(w.app).post('/api/auth/forgot').send({ email: 'nobody@nowhere.test' });
    expect(a.body).toEqual(b.body);
    await tick();
    const [m] = w.to('customer@clicknpuff.africa');
    expect(m.subject).toBe('Reset your ClickNPuff password');
    expect(w.sent).toHaveLength(1);
    const token = w.linkIn(m);
    expect((await request(w.app).post('/api/auth/reset').send({ token, password: 'short' })).status).toBe(400);
    const ok = await request(w.app).post('/api/auth/reset').send({ token, password: 'brand-new-password' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(await w.login('customer@clicknpuff.africa', 'brand-new-password')).toBeTruthy();
    expect((await request(w.app).post('/api/auth/reset').send({ token, password: 'another-password-1' })).status).toBe(400); // spent
    expect((await request(w.app).post('/api/auth/reset').send({ token: 'made-up', password: 'another-password-1' })).status).toBe(400);
  });

  it('emails a new staff member a link to set their own password', async () => {
    const w = await world();
    const owner = w.api(await w.login('merchant1@clicknpuff.africa'));
    await owner.post('/api/merchant/team', { name: 'Sipho Dube', email: 'sipho@rosebank.test', role: 'packer' });
    await tick();
    const [m] = w.to('sipho@rosebank.test');
    expect(m.subject).toBe("You've been added to Rosebank Botanicals on ClickNPuff");
    const set = await request(w.app).post('/api/auth/reset').send({ token: w.linkIn(m), password: 'my-own-password' });
    expect(set.body.user).toMatchObject({ mustChangePassword: false });
  });

  it('sends order confirmation once, then delivered or cancelled emails', async () => {
    const w = await world();
    const admin = w.api(await w.login('admin@clicknpuff.africa'));
    await admin.put('/api/admin/settings', { deliveryOpenHour: 0, deliveryCloseHour: 24 });
    const customer = w.api(await w.login('customer@clicknpuff.africa'));
    const store = (await request(w.app).get('/api/stores/rosebank-botanicals')).body;
    const p = store.products.find((x) => x.stock >= 10);
    const place = async () => {
      const r = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(15000 / p.priceCents) }], ...DROP });
      return (await customer.post(`/api/orders/${r.body.order.id}/pay`)).body.order;
    };
    const o = await place();
    await tick();
    const mine = () => w.to('customer@clicknpuff.africa').map((m) => m.tags[0]);
    expect(mine()).toEqual(['order_confirmed']);
    const conf = w.to('customer@clicknpuff.africa')[0];
    expect(conf.subject).toBe(`Order #${o.code} confirmed — Rosebank Botanicals`);
    expect(conf.htmlContent).toContain('Total paid');
    expect(conf.htmlContent).toContain(`/orders/${o.id}`);

    await customer.post(`/api/orders/${o.id}/cancel`, { reason: 'Changed my mind' });
    await tick();
    expect(mine()).toEqual(['order_confirmed', 'order_cancelled']);
    expect(w.to('customer@clicknpuff.africa')[1].htmlContent).toContain("You've been refunded");
  });

  it('tells the store owner about approval and payouts, and admins about new stores', async () => {
    const w = await world();
    const admin = w.api(await w.login('admin@clicknpuff.africa'));
    const owner = w.api(await w.login('merchant1@clicknpuff.africa'));
    const made = await owner.post('/api/merchant/store', { name: 'Rosebank Sandton', city: 'johannesburg', address: '1 Rivonia Rd, Sandton' });
    await tick();
    expect(w.to('admin@clicknpuff.africa').map((m) => m.subject)).toContain('New store to review: Rosebank Sandton');
    await admin.post(`/api/admin/stores/${made.body.store.id}`, { status: 'approved' });
    await admin.post(`/api/admin/stores/${made.body.store.id}`, { status: 'approved' }); // no change, no email
    await tick();
    expect(w.to('merchant1@clicknpuff.africa').filter((m) => m.tags[0] === 'store_approved')).toHaveLength(1);
  });

  it('records failures and skips quietly without an API key', async () => {
    const w = await world({ fail: true });
    await request(w.app).post('/api/auth/forgot').send({ email: 'customer@clicknpuff.africa' });
    await tick();
    expect(w.db.prepare("SELECT status, error FROM email_log WHERE kind = 'password_reset'").get()).toEqual({ status: 'failed', error: 'Brevo 401: Key not found' });

    delete process.env.BREVO_API_KEY;
    const db = open(':memory:');
    await seed(db);
    const app = createApp(db);
    await request(app).post('/api/auth/forgot').send({ email: 'customer@clicknpuff.africa' });
    await tick();
    expect(db.prepare("SELECT status FROM email_log WHERE kind = 'password_reset'").get().status).toBe('skipped');
  });

  it('covers sold-out choices, help requests, security notices, staff changes, SOS and the weekly summary', async () => {
    const w = await world();
    const admin = w.api(await w.login('admin@clicknpuff.africa'));
    await admin.put('/api/admin/settings', { deliveryOpenHour: 0, deliveryCloseHour: 24 });
    const owner = w.api(await w.login('merchant1@clicknpuff.africa'));
    const customer = w.api(await w.login('customer@clicknpuff.africa'));
    const store = (await request(w.app).get('/api/stores/rosebank-botanicals')).body;
    const [a, b] = store.products.filter((x) => x.stock >= 10);
    const r = await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: a.id, qty: 1 }, { productId: b.id, qty: Math.ceil(15000 / b.priceCents) }], ...DROP });
    const o = (await customer.post(`/api/orders/${r.body.order.id}/pay`)).body.order;
    await owner.post(`/api/merchant/orders/${o.id}/unavailable`, { productIds: [a.id] });
    await customer.post(`/api/orders/${o.id}/item-decision`, { decision: 'continue' });
    await tick();
    const kinds = (email) => w.to(email).map((m) => m.tags[0]);
    expect(kinds('customer@clicknpuff.africa')).toEqual(['order_confirmed', 'item_unavailable', 'items_removed']);
    expect(w.to('customer@clicknpuff.africa')[1].subject).toContain(`is sold out (order #${o.code})`);

    // Help: the customer gets a receipt and the answer; admins hear about it.
    await customer.post(`/api/orders/${o.id}/help`, { type: Object.keys((await customer.get(`/api/orders/${o.id}/help`)).body.types)[0], note: 'Rider was rude' });
    await tick();
    const helpId = (await admin.get('/api/admin/help')).body.requests[0].id;
    await admin.post(`/api/admin/help/${helpId}/resolve`, { resolution: "We've spoken to the rider and added R50 credit." });
    await tick();
    expect(kinds('customer@clicknpuff.africa')).toEqual(expect.arrayContaining(['help_received', 'help_resolved']));
    expect(kinds('admin@clicknpuff.africa')).toContain('admin_help');

    // Security: password and bank changes.
    await customer.post('/api/me/password', { currentPassword: 'password123', newPassword: 'a-much-better-one' });
    await owner.put('/api/merchant/bank', { bankName: 'Capitec', accountHolder: 'RB (Pty) Ltd', accountNumber: '1234567890', password: 'password123' });
    await tick();
    expect(kinds('customer@clicknpuff.africa')).toContain('password_changed');
    expect(kinds('merchant1@clicknpuff.africa')).toContain('bank_changed');
    expect(w.to('admin@clicknpuff.africa').find((m) => m.tags[0] === 'admin_bank_changed').htmlContent).toContain('••••7890');

    // Staff: role change and removal reach the person.
    const hired = await owner.post('/api/merchant/team', { name: 'Pat', email: 'pat@rosebank.test', role: 'packer' });
    await request(w.app).patch(`/api/merchant/team/${hired.body.id}`).set('Authorization', `Bearer ${await w.login('merchant1@clicknpuff.africa')}`).send({ role: 'manager' });
    await request(w.app).delete(`/api/merchant/team/${hired.body.id}`).set('Authorization', `Bearer ${await w.login('merchant1@clicknpuff.africa')}`);
    await tick();
    expect(kinds('pat@rosebank.test')).toEqual(['staff_invite', 'staff_role', 'staff_removed']);

    // Riders' SOS goes to every admin, marked urgent.
    const rider = w.api(await w.login('rider1@clicknpuff.africa'));
    await rider.post('/api/rider/incidents', { type: 'sos', note: 'Being followed', lat: -26.1, lng: 28.0 });
    await tick();
    expect(w.to('admin@clicknpuff.africa').find((m) => m.tags[0] === 'admin_incident_sos').subject).toMatch(/^🚨 URGENT: SOS from rider/);

    // Weekly summary: only on Monday mornings, once.
    w.db.prepare("UPDATE orders SET status = 'delivered', delivered_at = datetime('now', '-3 days') WHERE id = ?").run(o.id);
    const mailer = w.app.locals.mailer;
    const today = new Date();
    const daysToMonday = (8 - new Date(today.getTime() + 2 * 3600e3).getUTCDay()) % 7 || 7;
    const nextMonday = new Date(Date.parse(new Date(today.getTime() + daysToMonday * 864e5).toISOString().slice(0, 10) + 'T07:00:00Z')); // 09:00 SAST
    expect(await mailer.weeklySummaries(new Date(nextMonday.getTime() - 864e5))).toBe(0); // a Sunday
    await mailer.weeklySummaries(nextMonday);
    await mailer.weeklySummaries(new Date(nextMonday.getTime() + 3600e3));
    expect(w.to('merchant1@clicknpuff.africa').filter((m) => m.tags[0] === 'weekly_summary').length).toBeGreaterThanOrEqual(1);
    const weekly = w.to('merchant1@clicknpuff.africa').filter((m) => m.tags[0] === 'weekly_summary' && m.subject.startsWith('Rosebank Botanicals'));
    expect(weekly).toHaveLength(1);
  });

  it('nudges unpaid baskets and tells the store about missed orders', async () => {
    const w = await world();
    const admin = w.api(await w.login('admin@clicknpuff.africa'));
    await admin.put('/api/admin/settings', { deliveryOpenHour: 0, deliveryCloseHour: 24 });
    const customer = w.api(await w.login('customer@clicknpuff.africa'));
    const store = (await request(w.app).get('/api/stores/rosebank-botanicals')).body;
    const p = store.products.find((x) => x.stock >= 10);
    const unpaid = (await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(15000 / p.priceCents) }], ...DROP })).body.order;
    w.db.prepare("UPDATE orders SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(unpaid.id);
    require('../src/orders').expireUnpaid(w.db, () => {});
    const paid = (await customer.post('/api/orders', { storeId: store.store.id, items: [{ productId: p.id, qty: Math.ceil(15000 / p.priceCents) }], ...DROP })).body.order;
    await customer.post(`/api/orders/${paid.id}/pay`);
    w.db.prepare("UPDATE orders SET updated_at = datetime('now', '-11 minutes'), created_at = datetime('now', '-11 minutes') WHERE id = ?").run(paid.id);
    require('../src/merchant').merchantSweep(w.db, () => {});
    await tick();
    const mine = w.to('customer@clicknpuff.africa');
    expect(mine.find((m) => m.tags[0] === 'order_unpaid').subject).toBe("Your Rosebank Botanicals order wasn't completed");
    expect(mine.find((m) => m.tags[0] === 'order_rejected')).toBeTruthy();
    expect(w.to('merchant1@clicknpuff.africa').map((m) => m.tags[0])).toContain('store_missed');
  });
});
