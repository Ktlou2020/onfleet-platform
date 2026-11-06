'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const orders = require('./orders');

// The control room: dashboard numbers, the live map, order tools, customers,
// the admin team and the audit trail. Everything here needs an admin.

const ph = (list) => list.map(() => '?').join(',');
// South Africa is UTC+2 all year, so "a day" here is a SAST day.
const DAY = (col) => `date(${col}, '+2 hours')`;
const TODAY = "date('now', '+2 hours')";
const YESTERDAY = "date('now', '+2 hours', '-1 day')";
const LATE_GRACE_MINUTES = 10;
const NO_RIDER_ALERT_MINUTES = 3;
const STORE_SLOW_MINUTES = 5;

function registerAdminRoutes(app, { db, auth, audit }) {
  const admin = auth('admin');
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  // ---- Dashboard ------------------------------------------------------------
  function dayKpis(day) {
    const placed = one(`SELECT COUNT(*) AS n FROM orders WHERE status <> 'pending_payment' AND ${DAY('created_at')} = ${day}`).n;
    const d = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS gmv, COALESCE(SUM(service_fee_cents), 0) AS service,
        COALESCE(SUM(delivery_fee_cents), 0) AS delivery, COALESCE(SUM(rider_payout_cents), 0) AS payouts, COALESCE(SUM(tip_cents), 0) AS tips, COALESCE(SUM(discount_cents), 0) AS discounts,
        AVG((julianday(delivered_at) - julianday(created_at)) * 1440) AS minutes
      FROM orders WHERE status = 'delivered' AND ${DAY('delivered_at')} = ${day}`);
    const failed = one(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('cancelled','rejected','returned') AND payment_status <> 'unpaid'
      AND ${DAY('created_at')} = ${day}`).n;
    const customers = one(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND ${DAY('created_at')} = ${day}`).n;
    return {
      ordersPlaced: placed,
      ordersDelivered: d.n,
      gmvCents: d.gmv,
      // What the platform keeps: its fees, less what it pays riders and the
      // promo discounts it funds. Tips pass straight through to riders.
      netRevenueCents: d.service + d.delivery - d.payouts - d.discounts,
      discountsCents: d.discounts,
      avgDeliveryMinutes: d.minutes == null ? null : Math.round(d.minutes),
      cancellationRate: placed ? Math.round((failed / placed) * 1000) / 10 : null,
      newCustomers: customers,
      tipsCents: d.tips,
    };
  }

  function actionQueue() {
    const items = [];
    const add = (severity, type, title, detail, ref) => items.push({ severity, type, title, detail, ref });
    for (const i of db.prepare(`SELECT i.id, i.type, i.note, i.at, u.name FROM incidents i JOIN users u ON u.id = i.rider_id
      WHERE i.resolved = 0 ORDER BY i.id DESC LIMIT 20`).all()) {
      add(i.type === 'sos' ? 'critical' : 'warning', 'incident', i.type === 'sos' ? `SOS from ${i.name}` : `${i.name}: ${i.type.replace('_', ' ')}`, i.note, { incidentId: i.id });
    }
    const late = db.prepare(`SELECT id, code, status, CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER) AS age, eta_minutes
      FROM orders WHERE status IN (${ph(orders.ACTIVE)}) AND (julianday('now') - julianday(created_at)) * 1440 > eta_minutes + ?`).all(...orders.ACTIVE, LATE_GRACE_MINUTES);
    for (const o of late) add('serious', 'late', `#${o.code} is running late`, `${o.age} min since order, promised ${o.eta_minutes}`, { orderId: o.id });
    const noRider = db.prepare(`SELECT id, code, CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER) AS age FROM orders
      WHERE rider_id IS NULL AND status IN (${ph(orders.WAITING_FOR_RIDER)}) AND (julianday('now') - julianday(updated_at)) * 1440 > ?`).all(...orders.WAITING_FOR_RIDER, NO_RIDER_ALERT_MINUTES);
    for (const o of noRider) add('serious', 'no_rider', `#${o.code} has no rider`, `Waiting ${o.age} min — no rider has taken it`, { orderId: o.id });
    const slowStore = db.prepare(`SELECT o.id, o.code, s.name, CAST((julianday('now') - julianday(o.updated_at)) * 1440 AS INTEGER) AS age
      FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.status = 'placed' AND (julianday('now') - julianday(o.updated_at)) * 1440 > ?`).all(STORE_SLOW_MINUTES);
    for (const o of slowStore) add('warning', 'store_slow', `${o.name} hasn't accepted #${o.code}`, `${o.age} min since payment`, { orderId: o.id });
    const help = one("SELECT COUNT(*) AS n FROM help_requests WHERE status = 'open'").n;
    if (help) add('warning', 'help', `${help} customer help request${help > 1 ? 's' : ''}`, 'Reply in Incidents', { section: 'incidents' });
    const pending = one("SELECT COUNT(*) AS n FROM stores WHERE status = 'pending'").n;
    if (pending) add('info', 'stores', `${pending} store${pending > 1 ? 's' : ''} waiting for approval`, 'Review in Stores', { section: 'stores' });
    const licences = one('SELECT COUNT(*) AS n FROM stores WHERE licence_number IS NOT NULL AND licence_verified = 0').n;
    if (licences) add('info', 'licences', `${licences} licence${licences > 1 ? 's' : ''} to verify`, 'Review in Stores', { section: 'stores' });
    const rank = { critical: 0, serious: 1, warning: 2, info: 3 };
    return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  app.get('/api/admin/dashboard', admin, (req, res) => {
    const daily = db.prepare(`SELECT ${DAY('created_at')} AS day, COUNT(*) AS placed,
        SUM(status = 'delivered') AS delivered, COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_cents END), 0) AS gmv
      FROM orders WHERE status <> 'pending_payment' AND ${DAY('created_at')} > date('now', '+2 hours', '-14 days')
      GROUP BY day`).all();
    const byDay = Object.fromEntries(daily.map((d) => [d.day, d]));
    const [y, m, d] = one(`SELECT ${TODAY} AS d`).d.split('-').map(Number);
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
      days.push({ day, placed: byDay[day]?.placed || 0, delivered: byDay[day]?.delivered || 0, gmvCents: byDay[day]?.gmv || 0 });
    }
    const hourlyRows = db.prepare(`SELECT CAST(strftime('%H', created_at, '+2 hours') AS INTEGER) AS h, COUNT(*) AS n FROM orders
      WHERE status <> 'pending_payment' AND ${DAY('created_at')} = ${TODAY} GROUP BY h`).all();
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: hourlyRows.find((r) => r.h === h)?.n || 0 }));
    const topStores = db.prepare(`SELECT s.id, s.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total_cents), 0) AS gmv, s.rating_sum, s.rating_count
      FROM stores s JOIN orders o ON o.store_id = s.id AND o.status = 'delivered' AND o.delivered_at > datetime('now', '-7 days')
      GROUP BY s.id ORDER BY gmv DESC LIMIT 5`).all()
      .map((s) => ({ id: s.id, name: s.name, orders: s.orders, gmvCents: s.gmv, rating: s.rating_count ? Math.round((s.rating_sum / s.rating_count) * 10) / 10 : null }));
    res.json({
      today: dayKpis(TODAY),
      yesterday: dayKpis(YESTERDAY),
      live: {
        activeOrders: one(`SELECT COUNT(*) AS n FROM orders WHERE status IN (${ph(orders.ACTIVE)})`, ...orders.ACTIVE).n,
        ridersOnline: one('SELECT COUNT(*) AS n FROM riders WHERE online = 1').n,
        ridersBusy: one(`SELECT COUNT(DISTINCT rider_id) AS n FROM orders WHERE status IN (${ph(orders.RIDER_ACTIVE)}) AND rider_id IS NOT NULL`, ...orders.RIDER_ACTIVE).n,
        storesOpen: one("SELECT COUNT(*) AS n FROM stores WHERE status = 'approved' AND is_open = 1").n,
      },
      actions: actionQueue(),
      days,
      hourly,
      topStores,
    });
  });

  // ---- Live map ---------------------------------------------------------------
  app.get('/api/admin/live', admin, (req, res) => {
    const active = db.prepare(`SELECT o.id, o.code, o.status, o.lat, o.lng, o.address, o.rider_id, o.eta_minutes,
        CAST((julianday('now') - julianday(o.created_at)) * 1440 AS INTEGER) AS age, s.name AS store_name, s.lat AS store_lat, s.lng AS store_lng,
        u.name AS rider_name
      FROM orders o JOIN stores s ON s.id = o.store_id LEFT JOIN users u ON u.id = o.rider_id
      WHERE o.status IN (${ph(orders.ACTIVE)}) ORDER BY o.id`).all(...orders.ACTIVE);
    const riders = db.prepare(`SELECT u.id, u.name, r.lat, r.lng, r.located_at, r.paused, r.vehicle,
        (SELECT code FROM orders o WHERE o.rider_id = u.id AND o.status IN (${ph(orders.RIDER_ACTIVE)}) LIMIT 1) AS current_code
      FROM riders r JOIN users u ON u.id = r.user_id WHERE r.online = 1 AND r.lat IS NOT NULL`).all(...orders.RIDER_ACTIVE);
    const stores = db.prepare("SELECT id, name, lat, lng, is_open FROM stores WHERE status = 'approved'").all();
    res.json({
      orders: active.map((o) => ({
        id: o.id, code: o.code, status: o.status, ageMinutes: o.age, etaMinutes: o.eta_minutes, late: o.age > o.eta_minutes + LATE_GRACE_MINUTES,
        store: { name: o.store_name, lat: o.store_lat, lng: o.store_lng }, dropoff: { lat: o.lat, lng: o.lng, address: o.address },
        rider: o.rider_id ? { id: o.rider_id, name: o.rider_name } : null,
      })),
      riders: riders.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, at: r.located_at, paused: !!r.paused, vehicle: r.vehicle, currentOrder: r.current_code })),
      stores: stores.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, open: !!s.is_open })),
    });
  });

  // ---- Orders -----------------------------------------------------------------
  const STATUS_GROUPS = {
    active: orders.ACTIVE,
    scheduled: ['scheduled'],
    needs_rider: orders.WAITING_FOR_RIDER,
    delivered: ['delivered'],
    problems: ['cancelled', 'rejected', 'returned'],
    unpaid: ['pending_payment'],
  };

  app.get('/api/admin/orders', admin, (req, res) => {
    const where = [];
    const args = [];
    const group = STATUS_GROUPS[req.query.status];
    if (group) {
      where.push(`o.status IN (${ph(group)})`);
      args.push(...group);
      if (req.query.status === 'needs_rider') where.push('o.rider_id IS NULL');
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      where.push('(o.code LIKE ? OR c.name LIKE ? OR c.email LIKE ? OR s.name LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const ids = db.prepare(`SELECT o.id FROM orders o JOIN users c ON c.id = o.customer_id JOIN stores s ON s.id = o.store_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.id DESC LIMIT 100`).all(...args);
    res.json({ orders: ids.map(({ id }) => orders.orderView(db, id, 'admin')) });
  });

  app.get('/api/admin/orders/:id', admin, (req, res) => {
    const view = orders.orderView(db, Number(req.params.id), 'admin');
    if (!view) return res.status(404).json({ error: 'Order not found' });
    const offers = db.prepare(`SELECT l.outcome, l.at, u.name FROM offer_log l JOIN users u ON u.id = l.rider_id
      WHERE l.order_id = ? ORDER BY l.id`).all(view.id);
    const o = one('SELECT customer_id, payment_ref, id_checked FROM orders WHERE id = ?', view.id);
    const customer = one(`SELECT u.id, u.email, u.phone, u.created_at, (SELECT COUNT(*) FROM orders WHERE customer_id = u.id AND status = 'delivered') AS delivered
      FROM users u WHERE u.id = ?`, o.customer_id);
    res.json({ order: view, offers, paymentRef: o.payment_ref, idChecked: !!o.id_checked, customer });
  });

  // Take an order off a rider who has not collected it yet and offer it
  // again — for a rider who has gone quiet or is stuck.
  app.post('/api/admin/orders/:id/reassign', admin, (req, res) => {
    const o = one('SELECT * FROM orders WHERE id = ?', req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status === 'picked_up') return res.status(409).json({ error: 'The rider already has the goods — call them instead' });
    if (!o.rider_id || !orders.WAITING_FOR_RIDER.includes(o.status)) return res.status(409).json({ error: 'This order has no rider to take it from' });
    db.prepare(`UPDATE orders SET rider_id = NULL, rider_assigned_at = NULL, arrived_store_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(o.id);
    // The old rider passed on it, so it is not offered back to them.
    db.prepare("INSERT INTO offer_log (order_id, rider_id, outcome) VALUES (?, ?, 'declined')").run(o.id, o.rider_id);
    orders.logEvent(db, o.id, 'rider_unassigned', String(req.body?.reason || 'Reassigned by support').slice(0, 200));
    orders.bus.emit('rider', o.rider_id);
    orders.offerNext(db, o.id);
    orders.bus.emit('order', o.id);
    audit(req.user.id, 'order_reassigned', { orderId: o.id, fromRider: o.rider_id });
    res.json({ order: orders.orderView(db, o.id, 'admin') });
  });

  // ---- Customers ----------------------------------------------------------------
  app.get('/api/admin/customers', admin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.age_verified, u.suspended, u.created_at, u.last_login_at,
        COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total_cents END), 0) AS spend, MAX(o.created_at) AS last_order
      FROM users u LEFT JOIN orders o ON o.customer_id = u.id AND o.status <> 'pending_payment'
      WHERE u.role = 'customer' AND (? = '' OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
      GROUP BY u.id ORDER BY spend DESC, u.id DESC LIMIT 100`).all(q, `%${q}%`, `%${q}%`, `%${q}%`);
    res.json({
      customers: rows.map((u) => ({
        id: u.id, name: u.name, email: u.email, phone: u.phone, ageVerified: !!u.age_verified, suspended: !!u.suspended,
        joinedAt: u.created_at, lastLoginAt: u.last_login_at, orders: u.orders, spendCents: u.spend, lastOrderAt: u.last_order,
      })),
    });
  });

  app.post('/api/admin/users/:id/suspend', admin, (req, res) => {
    const u = one('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.role === 'admin') return res.status(400).json({ error: 'Remove admins from the Team page' });
    const suspended = req.body?.suspended ? 1 : 0;
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended, u.id);
    if (suspended && u.role === 'rider') {
      db.prepare('UPDATE riders SET online = 0 WHERE user_id = ?').run(u.id);
      const held = db.prepare('SELECT id FROM orders WHERE offered_rider_id = ?').all(u.id);
      for (const { id } of held) orders.declineOffer(db, id, u.id);
    }
    audit(req.user.id, suspended ? 'user_suspended' : 'user_reinstated', { userId: u.id, role: u.role, reason: req.body?.reason });
    res.json({ ok: true, suspended: !!suspended });
  });

  // ---- Team -------------------------------------------------------------------
  app.get('/api/admin/team', admin, (req, res) => {
    const rows = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.suspended, u.created_at, u.last_login_at,
        (SELECT MAX(at) FROM audit_log a WHERE a.user_id = u.id) AS last_action,
        (SELECT COUNT(*) FROM audit_log a WHERE a.user_id = u.id AND a.at > datetime('now', '-7 days')) AS actions_week
      FROM users u WHERE u.role = 'admin' ORDER BY u.suspended, u.name`).all();
    res.json({
      team: rows.map((u) => ({
        id: u.id, name: u.name, email: u.email, phone: u.phone, active: !u.suspended, you: u.id === req.user.id,
        joinedAt: u.created_at, lastLoginAt: u.last_login_at, lastActionAt: u.last_action, actionsThisWeek: u.actions_week,
      })),
    });
  });

  // A new admin gets a one-time temporary password, shown to whoever added
  // them and to nobody else; they change it from their profile.
  app.post('/api/admin/team', admin, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter their name' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (one('SELECT 1 FROM users WHERE email = ?', email)) return res.status(409).json({ error: 'That email already has an account' });
    const temp = crypto.randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(temp, 10);
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, password_hash, name, role, age_verified, must_change_password)
      VALUES (?, ?, ?, 'admin', 1, 1)`).run(email, hash, name);
    audit(req.user.id, 'admin_added', { userId: lastInsertRowid, email });
    res.status(201).json({ id: lastInsertRowid, email, temporaryPassword: temp });
  });

  app.post('/api/admin/team/:id/access', admin, (req, res) => {
    const u = one("SELECT * FROM users WHERE id = ? AND role = 'admin'", req.params.id);
    if (!u) return res.status(404).json({ error: 'Admin not found' });
    const active = !!req.body?.active;
    if (!active && u.id === req.user.id) return res.status(400).json({ error: "You can't remove your own access" });
    if (!active && one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND suspended = 0").n <= 1) return res.status(400).json({ error: 'There must always be at least one admin' });
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(active ? 0 : 1, u.id);
    audit(req.user.id, active ? 'admin_restored' : 'admin_removed', { userId: u.id });
    res.json({ ok: true });
  });

  // ---- Audit log ------------------------------------------------------------
  app.get('/api/admin/audit', admin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const mine = req.query.mine === '1';
    const rows = db.prepare(`SELECT a.id, a.action, a.detail, a.at, u.name, u.role FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE (? = 0 OR a.user_id = ?) AND (? = '' OR a.action LIKE ? OR u.name LIKE ? OR a.detail LIKE ?)
      ORDER BY a.id DESC LIMIT ?`).all(mine ? 1 : 0, req.user.id, q, `%${q}%`, `%${q}%`, `%${q}%`, Math.min(Number(req.query.limit) || 100, 300));
    res.json({
      entries: rows.map((r) => {
        let detail = null;
        try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = r.detail; }
        return { id: r.id, action: r.action, detail, at: r.at, by: r.name ? { name: r.name, role: r.role } : null };
      }),
    });
  });

}

module.exports = { registerAdminRoutes };
